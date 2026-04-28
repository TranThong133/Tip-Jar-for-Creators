#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::StellarAssetClient,
    Address, Env, String,
};

const STARTING_BALANCE: i128 = 10_000_000_000; // 1000 XLM in stroops

struct Fixture<'a> {
    env: Env,
    client: TipJarClient<'a>,
    sender: Address,
    creator: Address,
    native_addr: Address,
    supporter_addr: Address,
}

fn setup<'a>() -> Fixture<'a> {
    let env = Env::default();
    // The supporter-token mint runs as a sub-invocation triggered by TipJar,
    // so we need to mock auth at all depths, not just the root call.
    env.mock_all_auths_allowing_non_root_auth();

    // Register a fresh native-XLM SAC for the test.
    let native_admin = Address::generate(&env);
    let native_sac = env.register_stellar_asset_contract_v2(native_admin);
    let native_addr = native_sac.address();

    // The supporter token is mocked with another SAC — its `mint(to, amount)`
    // signature matches what we invoke from TipJar, so it exercises the
    // inter-contract call path without needing the real SupporterToken crate.
    let supporter_admin = Address::generate(&env);
    let supporter_sac = env.register_stellar_asset_contract_v2(supporter_admin);
    let supporter_addr = supporter_sac.address();

    // Deploy the TipJar with both addresses as constructor args.
    let contract_id = env.register(TipJar, (native_addr.clone(), supporter_addr.clone()));
    let client = TipJarClient::new(&env, &contract_id);

    // Mint starting XLM to a sender so it can tip.
    let sender = Address::generate(&env);
    StellarAssetClient::new(&env, &native_addr).mint(&sender, &STARTING_BALANCE);

    let creator = Address::generate(&env);
    Fixture {
        env,
        client,
        sender,
        creator,
        native_addr,
        supporter_addr,
    }
}

#[test]
fn tip_records_state_and_transfers_funds() {
    let f = setup();
    let amount: i128 = 50_000_000; // 5 XLM

    f.client
        .tip(&f.sender, &f.creator, &amount, &String::from_str(&f.env, "Thanks!"));

    assert_eq!(f.client.total_received(&f.creator), amount);
    assert_eq!(f.client.tip_count_for(&f.creator), 1);
    assert_eq!(f.client.global_count(), 1);

    let tips = f.client.recent_tips(&f.creator);
    assert_eq!(tips.len(), 1);
    let stored = tips.get(0).unwrap();
    assert_eq!(stored.amount, amount);
    assert_eq!(stored.sender, f.sender);

    // Funds moved from sender to creator via the native SAC.
    let native_token = soroban_sdk::token::Client::new(&f.env, &f.native_addr);
    assert_eq!(native_token.balance(&f.sender), STARTING_BALANCE - amount);
    assert_eq!(native_token.balance(&f.creator), amount);
}

#[test]
fn tip_mints_supporter_tokens_via_inter_contract_call() {
    let f = setup();
    let amount: i128 = 50_000_000; // 5 XLM
    f.client
        .tip(&f.sender, &f.creator, &amount, &String::from_str(&f.env, "Thanks!"));

    // The supporter-token mock's mint was called with (sender, amount).
    let supporter = soroban_sdk::token::Client::new(&f.env, &f.supporter_addr);
    assert_eq!(supporter.balance(&f.sender), amount);
}

#[test]
fn multiple_tips_accumulate_and_compound_supporter_balance() {
    let f = setup();

    f.client.tip(&f.sender, &f.creator, &10_000_000, &String::from_str(&f.env, "one"));
    f.client.tip(&f.sender, &f.creator, &20_000_000, &String::from_str(&f.env, "two"));
    f.client.tip(&f.sender, &f.creator, &30_000_000, &String::from_str(&f.env, "three"));

    assert_eq!(f.client.total_received(&f.creator), 60_000_000);
    assert_eq!(f.client.tip_count_for(&f.creator), 3);
    assert_eq!(f.client.recent_tips(&f.creator).len(), 3);

    let supporter = soroban_sdk::token::Client::new(&f.env, &f.supporter_addr);
    assert_eq!(supporter.balance(&f.sender), 60_000_000);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn rejects_zero_amount() {
    let f = setup();
    f.client.tip(&f.sender, &f.creator, &0, &String::from_str(&f.env, ""));
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn rejects_negative_amount() {
    let f = setup();
    f.client.tip(&f.sender, &f.creator, &-1, &String::from_str(&f.env, ""));
}

#[test]
fn recent_tips_caps_at_limit() {
    let f = setup();
    // Mint extra so we can run >50 tips without running out.
    let admin_client = StellarAssetClient::new(&f.env, &f.client.native_token());
    admin_client.mint(&f.sender, &STARTING_BALANCE);

    for _ in 0..(MAX_RECENT_TIPS + 5) {
        f.client.tip(&f.sender, &f.creator, &1, &String::from_str(&f.env, "."));
    }

    assert_eq!(f.client.recent_tips(&f.creator).len(), MAX_RECENT_TIPS);
    assert_eq!(f.client.tip_count_for(&f.creator), MAX_RECENT_TIPS + 5);
}
