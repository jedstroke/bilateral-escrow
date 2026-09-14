use starknet::ContractAddress;
use crate::types::{Deal, Fees, Windows};

#[starknet::interface]
pub trait IBilateralEscrow<TState> {
    // ---- customer ----

    /// Open a deal and pay `price + protection fee` into escrow.
    /// The customer must have approved the escrow to spend that amount first.
    fn create_deal(
        ref self: TState,
        merchant: ContractAddress,
        token: ContractAddress,
        price: u256,
        return_bond: u256,
        metadata: ByteArray,
    ) -> u64;
    /// Take the money back before the merchant accepts.
    fn cancel_deal(ref self: TState, deal_id: u64);
    /// Happy path. Pays the merchant.
    fn accept_goods(ref self: TState, deal_id: u64);
    /// Start a return. `reason` is free text or an IPFS CID.
    fn reject_goods(ref self: TState, deal_id: u64, reason: ByteArray);
    /// The goods are on their way back. `evidence` is an IPFS CID (tracking, photos).
    fn mark_returned(ref self: TState, deal_id: u64, evidence: ByteArray);

    // ---- merchant ----

    /// Accept the deal and post the return bond.
    /// The merchant must have approved the escrow to spend the bond first.
    fn accept_deal(ref self: TState, deal_id: u64);
    /// Walk away after accepting but before shipping. The bond goes to the customer.
    fn back_out(ref self: TState, deal_id: u64);
    /// Goods are on their way. `evidence` is an IPFS CID (tags, photos, tracking).
    fn mark_shipped(ref self: TState, deal_id: u64, evidence: ByteArray);
    /// The returned goods arrived and are fine. Refunds the customer.
    fn confirm_return(ref self: TState, deal_id: u64);

    // ---- either party ----

    /// Freeze the deal for the admin. Only after the goods have shipped.
    fn raise_dispute(ref self: TState, deal_id: u64, reason: ByteArray);

    // ---- anyone ----

    /// Move a deal forward when a deadline has passed. Anyone may call this.
    fn claim_timeout(ref self: TState, deal_id: u64);
    /// Pull whatever the caller has been credited in `token`.
    fn withdraw(ref self: TState, token: ContractAddress) -> u256;

    // ---- admin ----

    /// Split price and bond between the parties. `customer_*_bps` is the customer's share.
    fn resolve_dispute(
        ref self: TState, deal_id: u64, customer_price_bps: u16, customer_bond_bps: u16,
    );
    fn set_token_allowed(ref self: TState, token: ContractAddress, allowed: bool);
    fn set_fees(ref self: TState, fees: Fees);
    fn set_windows(ref self: TState, windows: Windows);
    fn set_treasury(ref self: TState, treasury: ContractAddress);
    /// Stops new deals and new acceptances. Open deals keep running.
    fn pause(ref self: TState);
    fn unpause(ref self: TState);

    // ---- views ----

    fn get_deal(self: @TState, deal_id: u64) -> Deal;
    fn get_metadata(self: @TState, deal_id: u64) -> ByteArray;
    fn get_shipment_evidence(self: @TState, deal_id: u64) -> ByteArray;
    fn get_return_evidence(self: @TState, deal_id: u64) -> ByteArray;
    fn get_balance(self: @TState, account: ContractAddress, token: ContractAddress) -> u256;
    fn is_token_allowed(self: @TState, token: ContractAddress) -> bool;
    fn get_fees(self: @TState) -> Fees;
    fn get_windows(self: @TState) -> Windows;
    fn get_treasury(self: @TState) -> ContractAddress;
    fn deal_count(self: @TState) -> u64;
    /// What the customer will pay on top of `price`.
    fn quote_protection_fee(self: @TState, price: u256) -> u256;
}
