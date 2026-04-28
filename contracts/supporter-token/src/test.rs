#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, token::TokenClient, Address, Env, String};

fn setup<'a>() -> (Env, SupporterTokenClient<'a>, TokenClient<'a>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(
        SupporterToken,
        (
            admin.clone(),
            7u32,
            String::from_str(&env, "Tip Jar Supporter"),
            String::from_str(&env, "TJS"),
        ),
    );
    let token = SupporterTokenClient::new(&env, &id);
    let standard = TokenClient::new(&env, &id);
    (env, token, standard, admin)
}

#[test]
fn metadata_is_set_by_constructor() {
    let (env, token, standard, admin) = setup();
    assert_eq!(standard.decimals(), 7);
    assert_eq!(standard.name(), String::from_str(&env, "Tip Jar Supporter"));
    assert_eq!(standard.symbol(), String::from_str(&env, "TJS"));
    assert_eq!(token.admin(), admin);
    assert_eq!(token.total_supply(), 0);
}

#[test]
fn admin_can_mint_and_balance_updates() {
    let (env, token, standard, _admin) = setup();
    let user = Address::generate(&env);
    token.mint(&user, &1_000);
    assert_eq!(standard.balance(&user), 1_000);
    assert_eq!(token.total_supply(), 1_000);
}

#[test]
fn transfer_moves_balance() {
    let (env, token, standard, _admin) = setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    token.mint(&alice, &500);
    standard.transfer(&alice, &bob, &200);
    assert_eq!(standard.balance(&alice), 300);
    assert_eq!(standard.balance(&bob), 200);
}

#[test]
fn approve_then_transfer_from_works() {
    let (env, token, standard, _admin) = setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let carol = Address::generate(&env);
    token.mint(&alice, &500);
    let expiration = env.ledger().sequence() + 100;
    standard.approve(&alice, &bob, &300, &expiration);
    assert_eq!(standard.allowance(&alice, &bob), 300);
    standard.transfer_from(&bob, &alice, &carol, &200);
    assert_eq!(standard.balance(&alice), 300);
    assert_eq!(standard.balance(&carol), 200);
    assert_eq!(standard.allowance(&alice, &bob), 100);
}

#[test]
fn burn_reduces_supply() {
    let (env, token, standard, _admin) = setup();
    let user = Address::generate(&env);
    token.mint(&user, &1_000);
    standard.burn(&user, &400);
    assert_eq!(standard.balance(&user), 600);
    assert_eq!(token.total_supply(), 600);
}

#[test]
fn set_admin_transfers_role() {
    let (env, token, _standard, _admin) = setup();
    let new_admin = Address::generate(&env);
    token.set_admin(&new_admin);
    assert_eq!(token.admin(), new_admin);
}
