#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, vec, Address, Env, IntoVal,
    String, Symbol, Val, Vec,
};

const MAX_RECENT_TIPS: u32 = 50;
const MAX_MESSAGE_LEN: u32 = 140;

#[contracttype]
#[derive(Clone)]
pub struct Tip {
    pub sender: Address,
    pub creator: Address,
    pub amount: i128,
    pub message: String,
    pub timestamp: u64,
}

#[contracttype]
pub enum DataKey {
    NativeToken,
    SupporterToken,
    GlobalCount,
    TotalFor(Address),
    CountFor(Address),
    TipsFor(Address),
}

#[contract]
pub struct TipJar;

#[contractimpl]
impl TipJar {
    /// Soroban runs this once on deploy when `--constructor-args` are supplied.
    /// `supporter_token` must be a contract whose `mint(to, amount)` accepts
    /// this contract's address as caller — i.e. this contract must be set as
    /// the supporter token's admin after deployment.
    pub fn __constructor(env: Env, native_token: Address, supporter_token: Address) {
        env.storage().instance().set(&DataKey::NativeToken, &native_token);
        env.storage().instance().set(&DataKey::SupporterToken, &supporter_token);
        env.storage().instance().set(&DataKey::GlobalCount, &0u64);
    }

    /// Send a tip from `sender` to `creator`. Transfers `amount` stroops of native XLM
    /// (via the configured Stellar Asset Contract) and records the tip on-chain.
    pub fn tip(env: Env, sender: Address, creator: Address, amount: i128, message: String) {
        sender.require_auth();
        if amount <= 0 {
            panic!("amount must be positive");
        }
        if message.len() > MAX_MESSAGE_LEN {
            panic!("message too long");
        }

        let native: Address = env
            .storage()
            .instance()
            .get(&DataKey::NativeToken)
            .expect("contract not initialized");

        token::Client::new(&env, &native).transfer(&sender, &creator, &amount);

        let timestamp = env.ledger().timestamp();
        let tip = Tip {
            sender: sender.clone(),
            creator: creator.clone(),
            amount,
            message: message.clone(),
            timestamp,
        };

        let total_key = DataKey::TotalFor(creator.clone());
        let prev_total: i128 = env.storage().persistent().get(&total_key).unwrap_or(0);
        env.storage().persistent().set(&total_key, &(prev_total + amount));

        let count_key = DataKey::CountFor(creator.clone());
        let prev_count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        env.storage().persistent().set(&count_key, &(prev_count + 1));

        let tips_key = DataKey::TipsFor(creator.clone());
        let mut tips: Vec<Tip> = env
            .storage()
            .persistent()
            .get(&tips_key)
            .unwrap_or_else(|| Vec::new(&env));
        tips.push_back(tip);
        while tips.len() > MAX_RECENT_TIPS {
            tips.pop_front_unchecked();
        }
        env.storage().persistent().set(&tips_key, &tips);

        let global: u64 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::GlobalCount, &(global + 1));

        // Inter-contract call: reward the tipper with supporter tokens.
        // Same scale as XLM (7 decimals) so 1 XLM tipped == 1 supporter token.
        let supporter: Address = env
            .storage()
            .instance()
            .get(&DataKey::SupporterToken)
            .expect("contract not initialized");
        let mint_args: Vec<Val> = vec![
            &env,
            sender.clone().into_val(&env),
            amount.into_val(&env),
        ];
        let _: () = env.invoke_contract(&supporter, &Symbol::new(&env, "mint"), mint_args);

        env.events().publish(
            (symbol_short!("tip"), creator),
            (sender, amount, message, timestamp),
        );
    }

    pub fn total_received(env: Env, creator: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::TotalFor(creator))
            .unwrap_or(0)
    }

    pub fn tip_count_for(env: Env, creator: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::CountFor(creator))
            .unwrap_or(0)
    }

    pub fn recent_tips(env: Env, creator: Address) -> Vec<Tip> {
        env.storage()
            .persistent()
            .get(&DataKey::TipsFor(creator))
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn global_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::GlobalCount)
            .unwrap_or(0)
    }

    pub fn native_token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::NativeToken)
            .expect("contract not initialized")
    }

    pub fn supporter_token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::SupporterToken)
            .expect("contract not initialized")
    }
}

mod test;
