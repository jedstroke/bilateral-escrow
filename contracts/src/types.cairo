use starknet::ContractAddress;

/// Where a deal is in its life. `None` means the id was never created.
#[derive(Drop, Copy, Serde, PartialEq, Debug, starknet::Store)]
pub enum DealState {
    #[default]
    None,
    /// Customer has paid in. Waiting for the merchant to accept.
    Created,
    /// Merchant posted the return bond. Must ship before the deadline.
    Accepted,
    /// Goods are on the way. Customer must accept or reject before the deadline.
    Shipped,
    /// Customer rejected. Must ship the goods back before the deadline.
    Returning,
    /// Goods are on the way back. Merchant must confirm before the deadline.
    Returned,
    /// Frozen. Only the admin can move it.
    Disputed,
    // ---- terminal states ----
    /// Merchant was paid.
    Completed,
    /// Customer was refunded.
    Refunded,
    /// Ended before anything shipped. Everyone got their own money back.
    Cancelled,
    /// Admin split the funds.
    Resolved,
}

/// How long each step may take, in seconds. Snapshotted into every deal at creation.
#[derive(Drop, Copy, Serde, PartialEq, Debug, starknet::Store)]
pub struct Windows {
    /// Merchant must accept within this time or the deal goes stale.
    pub accept: u64,
    /// After accepting, merchant must mark shipped within this time.
    pub ship: u64,
    /// After shipping, customer must accept or reject within this time.
    pub decision: u64,
    /// After rejecting, customer must mark the goods returned within this time.
    pub return_ship: u64,
    /// After the customer marks returned, merchant must confirm within this time.
    pub return_confirm: u64,
}

/// Fee settings in basis points (1 bps = 0.01%). Snapshotted into every deal.
#[derive(Drop, Copy, Serde, PartialEq, Debug, starknet::Store)]
pub struct Fees {
    /// Charged on the price. Paid by the customer on top of the price.
    pub protection_bps: u16,
    /// Share of the protection fee that goes to the treasury. The rest goes to the merchant.
    pub protocol_cut_bps: u16,
}

#[derive(Drop, Copy, Serde, PartialEq, Debug, starknet::Store)]
pub struct Deal {
    pub customer: ContractAddress,
    pub merchant: ContractAddress,
    pub token: ContractAddress,
    /// What the customer pays for the goods.
    pub price: u256,
    /// What the customer pays for protection. Computed from `fees.protection_bps`.
    pub protection_fee: u256,
    /// What the merchant must post. Covers return shipping if the customer rejects.
    pub return_bond: u256,
    pub state: DealState,
    pub created_at: u64,
    /// Deadline for the current state. 0 when there is none.
    pub deadline: u64,
    pub windows: Windows,
    pub fees: Fees,
}
