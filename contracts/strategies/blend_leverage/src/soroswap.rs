use defindex_strategy_core::StrategyError;
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    panic_with_error, vec, Address, Env, IntoVal, InvokeError, Symbol, Vec,
};

use crate::storage::Config;

/// Basis-point denominator: 10_000 bp = 100%.
const BPS_DENOMINATOR: u32 = 10_000;

/// Query the Soroswap router for a spot-price quote and apply the stored
/// slippage tolerance to derive `amount_out_min`.
///
/// Returns `quoted_out × (10_000 − slippage_bps) / 10_000`.
/// Falls back to `0` (no protection) if the router query fails or returns
/// an empty result, so a harvest is never blocked by a query failure alone.
pub fn compute_amount_out_min(
    e: &Env,
    amount_in: i128,
    path: Vec<Address>,
    config: &Config,
) -> i128 {
    // Query router for expected output amounts along the path.
    // Use try_invoke_contract so a failure returns Err rather than panicking.
    let quoted: Vec<i128> = e
        .try_invoke_contract::<Vec<i128>, InvokeError>(
            &config.router,
            &Symbol::new(e, "get_amounts_out"),
            vec![e, amount_in.into_val(e), path.into_val(e)].into_val(e),
        )
        .unwrap_or_else(|_| Ok(Vec::new(e)))
        .unwrap_or_else(|_| Vec::new(e));

    // Index 0 = amount_in, index 1 = amount_out for a two-token path.
    let quoted_out: i128 = quoted.get(1).unwrap_or(0);
    if quoted_out == 0 {
        return 0; // No quote available — fall back to no protection
    }

    // amount_out_min = quoted_out × (10_000 − slippage_bps) / 10_000
    let numerator = quoted_out
        .saturating_mul((BPS_DENOMINATOR - config.slippage_bps) as i128);
    numerator / BPS_DENOMINATOR as i128
}

/// Performs a token swap using the Soroswap router.
///
/// Swaps the specified amount of input tokens for a minimum amount of output tokens
/// along a given path. Handles authorization and contract invocations.
///
/// Copied from DeFindex blend_strategy/soroswap.rs with minor adaptations.
pub fn internal_swap_exact_tokens_for_tokens(
    e: &Env,
    amount_in: &i128,
    amount_out_min: &i128,
    path: Vec<Address>,
    to: &Address,
    deadline: &u64,
    config: &Config,
) -> Result<Vec<i128>, StrategyError> {
    let swap_args = vec![
        e,
        amount_in.into_val(e),
        amount_out_min.into_val(e),
        path.clone().into_val(e),
        to.to_val(),
        deadline.into_val(e),
    ];

    // Get pair address for authorization
    let pair_address = e
        .try_invoke_contract::<Address, InvokeError>(
            &config.router,
            &Symbol::new(e, "router_pair_for"),
            path.clone().into_val(e),
        )
        .unwrap_or_else(|_| {
            panic_with_error!(e, StrategyError::SoroswapPairError);
        })
        .unwrap();

    // Authorize the transfer of input tokens to the pair
    e.authorize_as_current_contract(vec![
        e,
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: match path.get(0) {
                    Some(address) => address.clone(),
                    None => {
                        panic_with_error!(e, StrategyError::InvalidArgument);
                    }
                },
                fn_name: Symbol::new(e, "transfer"),
                args: (
                    e.current_contract_address(),
                    pair_address,
                    amount_in.clone(),
                )
                    .into_val(e),
            },
            sub_invocations: vec![e],
        }),
    ]);

    let result = e
        .try_invoke_contract::<Vec<i128>, InvokeError>(
            &config.router,
            &Symbol::new(e, "swap_exact_tokens_for_tokens"),
            swap_args.into_val(e),
        )
        .unwrap_or_else(|_| {
            panic_with_error!(e, StrategyError::InternalSwapError);
        })
        .unwrap();

    Ok(result)
}
