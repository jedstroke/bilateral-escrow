/// Bilateral escrow between a customer and a merchant.
///
/// Money never leaves this contract on its own. Every settlement only *credits* an internal
/// balance; each party then calls `withdraw` to pull it. That keeps external token calls out
/// of the settlement logic, so no party can block or re-enter another party's payout.
#[starknet::contract]
pub mod BilateralEscrow {
    use core::num::traits::Zero;
    use openzeppelin_access::ownable::OwnableComponent;
    use openzeppelin_interfaces::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use openzeppelin_security::{PausableComponent, ReentrancyGuardComponent};
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};
    use crate::interface::IBilateralEscrow;
    use crate::types::{Deal, DealState, Fees, Windows};

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: PausableComponent, storage: pausable, event: PausableEvent);
    component!(path: ReentrancyGuardComponent, storage: reentrancy, event: ReentrancyGuardEvent);

    // Two-step ownership: the new admin must claim it, so a typo cannot lock the contract.
    #[abi(embed_v0)]
    impl OwnableTwoStepMixinImpl =
        OwnableComponent::OwnableTwoStepMixinImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;

    #[abi(embed_v0)]
    impl PausableImpl = PausableComponent::PausableImpl<ContractState>;
    impl PausableInternalImpl = PausableComponent::InternalImpl<ContractState>;

    impl ReentrancyGuardInternalImpl = ReentrancyGuardComponent::InternalImpl<ContractState>;

    const BPS: u256 = 10000;

    pub mod Errors {
        pub const ZERO_ADDRESS: felt252 = 'ESC: zero address';
        pub const SELF_DEAL: felt252 = 'ESC: self deal';
        pub const TOKEN_NOT_ALLOWED: felt252 = 'ESC: token not allowed';
        pub const ZERO_PRICE: felt252 = 'ESC: zero price';
        pub const NOT_FOUND: felt252 = 'ESC: deal not found';
        pub const BAD_STATE: felt252 = 'ESC: bad state';
        pub const NOT_CUSTOMER: felt252 = 'ESC: not customer';
        pub const NOT_MERCHANT: felt252 = 'ESC: not merchant';
        pub const NOT_PARTY: felt252 = 'ESC: not a party';
        pub const EXPIRED: felt252 = 'ESC: deadline passed';
        pub const NOT_EXPIRED: felt252 = 'ESC: deadline not passed';
        pub const TRANSFER_FAILED: felt252 = 'ESC: transfer failed';
        pub const NOTHING_TO_WITHDRAW: felt252 = 'ESC: nothing to withdraw';
        pub const BAD_BPS: felt252 = 'ESC: bps > 10000';
        pub const ZERO_WINDOW: felt252 = 'ESC: zero window';
    }

    /// Why a deal ended. Used in `DealSettled.outcome`.
    pub mod Outcome {
        pub const CUSTOMER_CANCELLED: felt252 = 'customer_cancelled';
        pub const ACCEPT_TIMEOUT: felt252 = 'accept_timeout';
        pub const MERCHANT_BACKED_OUT: felt252 = 'merchant_backed_out';
        pub const SHIP_TIMEOUT: felt252 = 'ship_timeout';
        pub const GOODS_ACCEPTED: felt252 = 'goods_accepted';
        pub const DECISION_TIMEOUT: felt252 = 'decision_timeout';
        pub const RETURN_TIMEOUT: felt252 = 'return_timeout';
        pub const RETURN_CONFIRMED: felt252 = 'return_confirmed';
        pub const RETURN_CONFIRM_TIMEOUT: felt252 = 'return_confirm_timeout';
        pub const ADMIN_RESOLVED: felt252 = 'admin_resolved';
    }

    #[storage]
    struct Storage {
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        #[substorage(v0)]
        pausable: PausableComponent::Storage,
        #[substorage(v0)]
        reentrancy: ReentrancyGuardComponent::Storage,
        treasury: ContractAddress,
        fees: Fees,
        windows: Windows,
        allowed_tokens: Map<ContractAddress, bool>,
        deal_count: u64,
        deals: Map<u64, Deal>,
        deal_metadata: Map<u64, ByteArray>,
        shipment_evidence: Map<u64, ByteArray>,
        return_evidence: Map<u64, ByteArray>,
        /// (account, token) -> amount the account may withdraw.
        balances: Map<(ContractAddress, ContractAddress), u256>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        #[flat]
        PausableEvent: PausableComponent::Event,
        #[flat]
        ReentrancyGuardEvent: ReentrancyGuardComponent::Event,
        DealCreated: DealCreated,
        DealAccepted: DealAccepted,
        GoodsShipped: GoodsShipped,
        GoodsRejected: GoodsRejected,
        GoodsReturned: GoodsReturned,
        DisputeRaised: DisputeRaised,
        DisputeResolved: DisputeResolved,
        DealSettled: DealSettled,
        Withdrawn: Withdrawn,
        TokenAllowed: TokenAllowed,
        FeesUpdated: FeesUpdated,
        WindowsUpdated: WindowsUpdated,
        TreasuryUpdated: TreasuryUpdated,
    }

    #[derive(Drop, starknet::Event)]
    pub struct DealCreated {
        #[key]
        pub deal_id: u64,
        #[key]
        pub customer: ContractAddress,
        #[key]
        pub merchant: ContractAddress,
        pub token: ContractAddress,
        pub price: u256,
        pub protection_fee: u256,
        pub return_bond: u256,
        pub deadline: u64,
        pub metadata: ByteArray,
    }

    #[derive(Drop, starknet::Event)]
    pub struct DealAccepted {
        #[key]
        pub deal_id: u64,
        pub deadline: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct GoodsShipped {
        #[key]
        pub deal_id: u64,
        pub deadline: u64,
        pub evidence: ByteArray,
    }

    #[derive(Drop, starknet::Event)]
    pub struct GoodsRejected {
        #[key]
        pub deal_id: u64,
        pub deadline: u64,
        pub reason: ByteArray,
    }

    #[derive(Drop, starknet::Event)]
    pub struct GoodsReturned {
        #[key]
        pub deal_id: u64,
        pub deadline: u64,
        pub evidence: ByteArray,
    }

    #[derive(Drop, starknet::Event)]
    pub struct DisputeRaised {
        #[key]
        pub deal_id: u64,
        #[key]
        pub by: ContractAddress,
        pub reason: ByteArray,
    }

    #[derive(Drop, starknet::Event)]
    pub struct DisputeResolved {
        #[key]
        pub deal_id: u64,
        pub customer_price_bps: u16,
        pub customer_bond_bps: u16,
    }

    /// Emitted once per deal, when it reaches a terminal state. Amounts are what got credited.
    #[derive(Drop, starknet::Event)]
    pub struct DealSettled {
        #[key]
        pub deal_id: u64,
        pub outcome: felt252,
        pub state: DealState,
        pub to_customer: u256,
        pub to_merchant: u256,
        pub to_treasury: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Withdrawn {
        #[key]
        pub account: ContractAddress,
        #[key]
        pub token: ContractAddress,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct TokenAllowed {
        #[key]
        pub token: ContractAddress,
        pub allowed: bool,
    }

    #[derive(Drop, starknet::Event)]
    pub struct FeesUpdated {
        pub fees: Fees,
    }

    #[derive(Drop, starknet::Event)]
    pub struct WindowsUpdated {
        pub windows: Windows,
    }

    #[derive(Drop, starknet::Event)]
    pub struct TreasuryUpdated {
        pub treasury: ContractAddress,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        treasury: ContractAddress,
        fees: Fees,
        windows: Windows,
    ) {
        assert(owner.is_non_zero(), Errors::ZERO_ADDRESS);
        self.ownable.initializer(owner);
        self._set_treasury(treasury);
        self._set_fees(fees);
        self._set_windows(windows);
    }

    #[abi(embed_v0)]
    impl BilateralEscrowImpl of IBilateralEscrow<ContractState> {
        // ------------------------------------------------------------------ customer

        fn create_deal(
            ref self: ContractState,
            merchant: ContractAddress,
            token: ContractAddress,
            price: u256,
            return_bond: u256,
            metadata: ByteArray,
        ) -> u64 {
            self.reentrancy.start();
            self.pausable.assert_not_paused();
            let customer = get_caller_address();
            assert(merchant.is_non_zero(), Errors::ZERO_ADDRESS);
            assert(merchant != customer, Errors::SELF_DEAL);
            assert(self.allowed_tokens.read(token), Errors::TOKEN_NOT_ALLOWED);
            assert(price > 0, Errors::ZERO_PRICE);

            let fees = self.fees.read();
            let windows = self.windows.read();
            let protection_fee = bps_of(price, fees.protection_bps);
            let now = get_block_timestamp();
            let deadline = now + windows.accept;

            let deal_id = self.deal_count.read() + 1;
            self.deal_count.write(deal_id);
            self
                .deals
                .write(
                    deal_id,
                    Deal {
                        customer,
                        merchant,
                        token,
                        price,
                        protection_fee,
                        return_bond,
                        state: DealState::Created,
                        created_at: now,
                        deadline,
                        windows,
                        fees,
                    },
                );
            self.deal_metadata.write(deal_id, metadata.clone());

            // State is fully written. Now pull the funds.
            self._pull(token, customer, price + protection_fee);

            self
                .emit(
                    DealCreated {
                        deal_id,
                        customer,
                        merchant,
                        token,
                        price,
                        protection_fee,
                        return_bond,
                        deadline,
                        metadata,
                    },
                );
            self.reentrancy.end();
            deal_id
        }

        fn cancel_deal(ref self: ContractState, deal_id: u64) {
            self.reentrancy.start();
            let deal = self._load(deal_id);
            self._only(deal.customer, Errors::NOT_CUSTOMER);
            assert(deal.state == DealState::Created, Errors::BAD_STATE);
            // Bond was never posted, so only the customer's money is in here.
            self
                ._finalize(
                    deal_id,
                    deal,
                    DealState::Cancelled,
                    Outcome::CUSTOMER_CANCELLED,
                    deal.price + deal.protection_fee,
                    0,
                    0,
                );
            self.reentrancy.end();
        }

        fn accept_goods(ref self: ContractState, deal_id: u64) {
            self.reentrancy.start();
            let deal = self._load(deal_id);
            self._only(deal.customer, Errors::NOT_CUSTOMER);
            assert(deal.state == DealState::Shipped, Errors::BAD_STATE);
            // No deadline check here. Accepting late is fine; it only helps the merchant.
            self._pay_merchant(deal_id, deal, Outcome::GOODS_ACCEPTED);
            self.reentrancy.end();
        }

        fn reject_goods(ref self: ContractState, deal_id: u64, reason: ByteArray) {
            self.reentrancy.start();
            let mut deal = self._load(deal_id);
            self._only(deal.customer, Errors::NOT_CUSTOMER);
            assert(deal.state == DealState::Shipped, Errors::BAD_STATE);
            self._before_deadline(deal);
            deal.state = DealState::Returning;
            deal.deadline = get_block_timestamp() + deal.windows.return_ship;
            self.deals.write(deal_id, deal);
            self.emit(GoodsRejected { deal_id, deadline: deal.deadline, reason });
            self.reentrancy.end();
        }

        fn mark_returned(ref self: ContractState, deal_id: u64, evidence: ByteArray) {
            self.reentrancy.start();
            let mut deal = self._load(deal_id);
            self._only(deal.customer, Errors::NOT_CUSTOMER);
            assert(deal.state == DealState::Returning, Errors::BAD_STATE);
            self._before_deadline(deal);
            deal.state = DealState::Returned;
            deal.deadline = get_block_timestamp() + deal.windows.return_confirm;
            self.deals.write(deal_id, deal);
            self.return_evidence.write(deal_id, evidence.clone());
            self.emit(GoodsReturned { deal_id, deadline: deal.deadline, evidence });
            self.reentrancy.end();
        }

        // ------------------------------------------------------------------ merchant

        fn accept_deal(ref self: ContractState, deal_id: u64) {
            self.reentrancy.start();
            self.pausable.assert_not_paused();
            let mut deal = self._load(deal_id);
            self._only(deal.merchant, Errors::NOT_MERCHANT);
            assert(deal.state == DealState::Created, Errors::BAD_STATE);
            self._before_deadline(deal);
            deal.state = DealState::Accepted;
            deal.deadline = get_block_timestamp() + deal.windows.ship;
            self.deals.write(deal_id, deal);

            // State is written. Now pull the bond.
            self._pull(deal.token, deal.merchant, deal.return_bond);

            self.emit(DealAccepted { deal_id, deadline: deal.deadline });
            self.reentrancy.end();
        }

        fn back_out(ref self: ContractState, deal_id: u64) {
            self.reentrancy.start();
            let deal = self._load(deal_id);
            self._only(deal.merchant, Errors::NOT_MERCHANT);
            assert(deal.state == DealState::Accepted, Errors::BAD_STATE);
            // Merchant committed and then walked away. The bond compensates the customer.
            self
                ._finalize(
                    deal_id,
                    deal,
                    DealState::Cancelled,
                    Outcome::MERCHANT_BACKED_OUT,
                    deal.price + deal.protection_fee + deal.return_bond,
                    0,
                    0,
                );
            self.reentrancy.end();
        }

        fn mark_shipped(ref self: ContractState, deal_id: u64, evidence: ByteArray) {
            self.reentrancy.start();
            let mut deal = self._load(deal_id);
            self._only(deal.merchant, Errors::NOT_MERCHANT);
            assert(deal.state == DealState::Accepted, Errors::BAD_STATE);
            self._before_deadline(deal);
            deal.state = DealState::Shipped;
            deal.deadline = get_block_timestamp() + deal.windows.decision;
            self.deals.write(deal_id, deal);
            self.shipment_evidence.write(deal_id, evidence.clone());
            self.emit(GoodsShipped { deal_id, deadline: deal.deadline, evidence });
            self.reentrancy.end();
        }

        fn confirm_return(ref self: ContractState, deal_id: u64) {
            self.reentrancy.start();
            let deal = self._load(deal_id);
            self._only(deal.merchant, Errors::NOT_MERCHANT);
            assert(deal.state == DealState::Returned, Errors::BAD_STATE);
            self._refund_customer(deal_id, deal, Outcome::RETURN_CONFIRMED);
            self.reentrancy.end();
        }

        // ------------------------------------------------------------------ either party

        fn raise_dispute(ref self: ContractState, deal_id: u64, reason: ByteArray) {
            self.reentrancy.start();
            let mut deal = self._load(deal_id);
            let caller = get_caller_address();
            assert(caller == deal.customer || caller == deal.merchant, Errors::NOT_PARTY);
            let disputable = deal.state == DealState::Shipped
                || deal.state == DealState::Returning
                || deal.state == DealState::Returned;
            assert(disputable, Errors::BAD_STATE);
            // A dispute can be raised even after the deadline, as long as nobody has
            // claimed the timeout yet. Otherwise a party could be locked out by a few seconds.
            deal.state = DealState::Disputed;
            deal.deadline = 0;
            self.deals.write(deal_id, deal);
            self.emit(DisputeRaised { deal_id, by: caller, reason });
            self.reentrancy.end();
        }

        // ------------------------------------------------------------------ anyone

        fn claim_timeout(ref self: ContractState, deal_id: u64) {
            self.reentrancy.start();
            let deal = self._load(deal_id);
            assert(deal.deadline != 0, Errors::BAD_STATE);
            assert(get_block_timestamp() > deal.deadline, Errors::NOT_EXPIRED);
            match deal.state {
                // Nobody accepted. Customer gets everything back.
                DealState::Created => self
                    ._finalize(
                        deal_id,
                        deal,
                        DealState::Cancelled,
                        Outcome::ACCEPT_TIMEOUT,
                        deal.price + deal.protection_fee,
                        0,
                        0,
                    ),
                // Merchant accepted and never shipped. Customer gets the bond too.
                DealState::Accepted => self
                    ._finalize(
                        deal_id,
                        deal,
                        DealState::Cancelled,
                        Outcome::SHIP_TIMEOUT,
                        deal.price + deal.protection_fee + deal.return_bond,
                        0,
                        0,
                    ),
                // Customer went quiet with the goods. Merchant is paid.
                DealState::Shipped => self._pay_merchant(deal_id, deal, Outcome::DECISION_TIMEOUT),
                // Customer rejected but never sent the goods back. Merchant is paid.
                DealState::Returning => self._pay_merchant(deal_id, deal, Outcome::RETURN_TIMEOUT),
                // Merchant never confirmed the return. Customer is refunded.
                DealState::Returned => self
                    ._refund_customer(deal_id, deal, Outcome::RETURN_CONFIRM_TIMEOUT),
                _ => core::panic_with_felt252(Errors::BAD_STATE),
            }
            self.reentrancy.end();
        }

        fn withdraw(ref self: ContractState, token: ContractAddress) -> u256 {
            self.reentrancy.start();
            let caller = get_caller_address();
            let amount = self.balances.read((caller, token));
            assert(amount > 0, Errors::NOTHING_TO_WITHDRAW);
            // Zero the balance before the external call.
            self.balances.write((caller, token), 0);
            let ok = IERC20Dispatcher { contract_address: token }.transfer(caller, amount);
            assert(ok, Errors::TRANSFER_FAILED);
            self.emit(Withdrawn { account: caller, token, amount });
            self.reentrancy.end();
            amount
        }

        // ------------------------------------------------------------------ admin

        fn resolve_dispute(
            ref self: ContractState, deal_id: u64, customer_price_bps: u16, customer_bond_bps: u16,
        ) {
            self.ownable.assert_only_owner();
            self.reentrancy.start();
            let deal = self._load(deal_id);
            assert(deal.state == DealState::Disputed, Errors::BAD_STATE);

            let customer_price = bps_of(deal.price, customer_price_bps);
            let customer_bond = bps_of(deal.return_bond, customer_bond_bps);
            let (to_treasury, merchant_fee_share) = split_fee(deal);

            self.emit(DisputeResolved { deal_id, customer_price_bps, customer_bond_bps });
            self
                ._finalize(
                    deal_id,
                    deal,
                    DealState::Resolved,
                    Outcome::ADMIN_RESOLVED,
                    customer_price + customer_bond,
                    (deal.price - customer_price)
                        + (deal.return_bond - customer_bond)
                        + merchant_fee_share,
                    to_treasury,
                );
            self.reentrancy.end();
        }

        fn set_token_allowed(ref self: ContractState, token: ContractAddress, allowed: bool) {
            self.ownable.assert_only_owner();
            assert(token.is_non_zero(), Errors::ZERO_ADDRESS);
            self.allowed_tokens.write(token, allowed);
            self.emit(TokenAllowed { token, allowed });
        }

        fn set_fees(ref self: ContractState, fees: Fees) {
            self.ownable.assert_only_owner();
            self._set_fees(fees);
        }

        fn set_windows(ref self: ContractState, windows: Windows) {
            self.ownable.assert_only_owner();
            self._set_windows(windows);
        }

        fn set_treasury(ref self: ContractState, treasury: ContractAddress) {
            self.ownable.assert_only_owner();
            self._set_treasury(treasury);
        }

        fn pause(ref self: ContractState) {
            self.ownable.assert_only_owner();
            self.pausable.pause();
        }

        fn unpause(ref self: ContractState) {
            self.ownable.assert_only_owner();
            self.pausable.unpause();
        }

        // ------------------------------------------------------------------ views

        fn get_deal(self: @ContractState, deal_id: u64) -> Deal {
            self._load(deal_id)
        }

        fn get_metadata(self: @ContractState, deal_id: u64) -> ByteArray {
            self.deal_metadata.read(deal_id)
        }

        fn get_shipment_evidence(self: @ContractState, deal_id: u64) -> ByteArray {
            self.shipment_evidence.read(deal_id)
        }

        fn get_return_evidence(self: @ContractState, deal_id: u64) -> ByteArray {
            self.return_evidence.read(deal_id)
        }

        fn get_balance(
            self: @ContractState, account: ContractAddress, token: ContractAddress,
        ) -> u256 {
            self.balances.read((account, token))
        }

        fn is_token_allowed(self: @ContractState, token: ContractAddress) -> bool {
            self.allowed_tokens.read(token)
        }

        fn get_fees(self: @ContractState) -> Fees {
            self.fees.read()
        }

        fn get_windows(self: @ContractState) -> Windows {
            self.windows.read()
        }

        fn get_treasury(self: @ContractState) -> ContractAddress {
            self.treasury.read()
        }

        fn deal_count(self: @ContractState) -> u64 {
            self.deal_count.read()
        }

        fn quote_protection_fee(self: @ContractState, price: u256) -> u256 {
            bps_of(price, self.fees.read().protection_bps)
        }
    }

    fn bps_of(amount: u256, bps: u16) -> u256 {
        amount * bps.into() / BPS
    }

    /// (treasury share, merchant share) of the protection fee.
    fn split_fee(deal: Deal) -> (u256, u256) {
        let to_treasury = bps_of(deal.protection_fee, deal.fees.protocol_cut_bps);
        (to_treasury, deal.protection_fee - to_treasury)
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _load(self: @ContractState, deal_id: u64) -> Deal {
            let deal = self.deals.read(deal_id);
            assert(deal.state != DealState::None, Errors::NOT_FOUND);
            deal
        }

        fn _only(self: @ContractState, who: ContractAddress, error: felt252) {
            assert(get_caller_address() == who, error);
        }

        fn _before_deadline(self: @ContractState, deal: Deal) {
            assert(get_block_timestamp() <= deal.deadline, Errors::EXPIRED);
        }


        /// Pull `amount` of `token` from `from` into this contract.
        fn _pull(
            ref self: ContractState, token: ContractAddress, from: ContractAddress, amount: u256,
        ) {
            if amount == 0 {
                return;
            }
            let ok = IERC20Dispatcher { contract_address: token }
                .transfer_from(from, get_contract_address(), amount);
            assert(ok, Errors::TRANSFER_FAILED);
        }

        fn _credit(
            ref self: ContractState, account: ContractAddress, token: ContractAddress, amount: u256,
        ) {
            if amount == 0 {
                return;
            }
            let key = (account, token);
            self.balances.write(key, self.balances.read(key) + amount);
        }

        /// Goods shipped and the merchant wins: price + bond back + their share of the fee.
        fn _pay_merchant(ref self: ContractState, deal_id: u64, deal: Deal, outcome: felt252) {
            let (to_treasury, merchant_fee_share) = split_fee(deal);
            self
                ._finalize(
                    deal_id,
                    deal,
                    DealState::Completed,
                    outcome,
                    0,
                    deal.price + deal.return_bond + merchant_fee_share,
                    to_treasury,
                );
        }

        /// Goods shipped and came back: customer gets price + bond (return shipping).
        /// The protection fee is not refunded. It was the premium for exactly this case.
        fn _refund_customer(ref self: ContractState, deal_id: u64, deal: Deal, outcome: felt252) {
            let (to_treasury, merchant_fee_share) = split_fee(deal);
            self
                ._finalize(
                    deal_id,
                    deal,
                    DealState::Refunded,
                    outcome,
                    deal.price + deal.return_bond,
                    merchant_fee_share,
                    to_treasury,
                );
        }

        /// Move a deal to a terminal state and credit everyone. No external calls here.
        fn _finalize(
            ref self: ContractState,
            deal_id: u64,
            mut deal: Deal,
            state: DealState,
            outcome: felt252,
            to_customer: u256,
            to_merchant: u256,
            to_treasury: u256,
        ) {
            deal.state = state;
            deal.deadline = 0;
            self.deals.write(deal_id, deal);
            self._credit(deal.customer, deal.token, to_customer);
            self._credit(deal.merchant, deal.token, to_merchant);
            self._credit(self.treasury.read(), deal.token, to_treasury);
            self
                .emit(
                    DealSettled { deal_id, outcome, state, to_customer, to_merchant, to_treasury },
                );
        }

        fn _set_fees(ref self: ContractState, fees: Fees) {
            assert(fees.protection_bps.into() <= BPS, Errors::BAD_BPS);
            assert(fees.protocol_cut_bps.into() <= BPS, Errors::BAD_BPS);
            self.fees.write(fees);
            self.emit(FeesUpdated { fees });
        }

        fn _set_windows(ref self: ContractState, windows: Windows) {
            let all_set = windows.accept > 0
                && windows.ship > 0
                && windows.decision > 0
                && windows.return_ship > 0
                && windows.return_confirm > 0;
            assert(all_set, Errors::ZERO_WINDOW);
            self.windows.write(windows);
            self.emit(WindowsUpdated { windows });
        }

        fn _set_treasury(ref self: ContractState, treasury: ContractAddress) {
            assert(treasury.is_non_zero(), Errors::ZERO_ADDRESS);
            self.treasury.write(treasury);
            self.emit(TreasuryUpdated { treasury });
        }
    }
}
