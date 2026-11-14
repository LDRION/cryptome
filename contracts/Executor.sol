// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IERC20Balance {
    function balanceOf(address) external view returns (uint256);
}

interface IExtsload {
    function extsload(bytes32) external view returns (bytes32);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IV2Pair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256, uint256, address, bytes calldata) external;
}

interface IV3Pool {
    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256);
}

interface IPoolManager {
    function unlock(bytes calldata) external returns (bytes memory);
    function swap(PoolKey memory, SwapParams memory, bytes calldata) external returns (int256);
    function sync(address) external;
    function settle() external payable returns (uint256);
    function take(address, address, uint256) external;
}

/// Runs one cycle of swaps and reverts unless it ends with more of the start token than it
/// began with. The whole trade either pays or never happened, which is the no-loss rule
/// enforced by the chain rather than by the off-chain model.
///
/// The start token is borrowed from the Uniswap V4 PoolManager for the length of the call,
/// which charges nothing as long as it is repaid before the call ends. So a trade needs no
/// capital of its own.
///
/// The contract holds nothing between trades: profit goes straight to a treasury fixed at
/// deployment. A bad pool therefore finds nothing to drain, and a stolen sender key can only
/// start trades, never redirect money.
contract Executor {
    uint8 private constant KIND_V2 = 0;
    uint8 private constant KIND_V3 = 1;
    uint8 private constant KIND_V4 = 2;

    address private constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    IPoolManager private constant MANAGER = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
    uint160 private constant MIN_PRICE = 4295128740;
    uint160 private constant MAX_PRICE = 1461446703485210103287273052203988822378723970341;
    /// Where the V4 PoolManager keeps its pools.
    uint256 private constant V4_POOLS_SLOT = 6;
    uint256 private constant ONE = 1e18;
    /// A gap that widened is taken with a larger amount, up to this many times the planned one.
    uint256 private constant MAX_RESIZE = 2;

    struct Hop {
        uint8 kind;
        address pool;
        bool zeroForOne;
        address tokenIn;
        address tokenOut;
        uint24 fee;
        int24 tickSpacing;
        /// The V4 pool holds native ETH where the route says WETH.
        bool nativeLeg;
        /// This hop's price when the trade was decided. A square root price in Q96 for V3 and V4,
        /// and output reserve over input reserve in Q96 for V2.
        uint256 priceAtDecision;
    }

    struct Route {
        address start;
        uint256 amountIn;
        Hop[] hops;
        uint256 minProfit;
        /// The gap when decided and the narrowest still worth taking, as fractions of 1e18.
        uint256 startGap;
        uint256 minGap;
        /// The most this route may burn, so that a bad pool cannot starve the routes after it.
        uint256 gasLimit;
    }

    address private immutable owner;
    address private immutable treasury;
    /// The swap in progress. A pool's callback is trusted only to say how much it is owed, and
    /// never what to pay with, or a bad pool on a route could drain everything held here.
    address private transient activePool;
    address private transient activeToken;
    uint256 private transient activeMax;

    error NotOwner();
    error NotActivePool();
    error NoProfit(uint256 balanceBefore, uint256 balanceAfter);
    error WrongBlock();
    error GapClosed(uint256 gap);
    error TransferFailed();
    error UnknownKind();
    error OwedTooMuch(uint256 owed, uint256 max);
    error NothingWorked();

    constructor(address treasury_) {
        owner = msg.sender;
        treasury = treasury_;
    }

    receive() external payable {}

    /// A public transaction has no revert protection and pays for all the gas it burns, so
    /// everything that can already rule the trade out is checked before the first swap.
    ///
    /// What matters is the gap across the whole route, not any one price: both legs can drift
    /// together and leave it open. So the route's gap is worked out from the prices as they stand
    /// now, the trade stops if too little of it is left, and otherwise the amount follows the gap,
    /// because the best amount grows about in line with it. A startGap of zero skips all of this
    /// and trades the amount given.
    function run(
        address start,
        uint256 amountIn,
        Hop[] calldata hops,
        uint256 minProfit,
        uint256 startGap,
        uint256 minGap,
        uint256 targetBlock
    ) external returns (uint256 profit, uint256[] memory outs, uint256 gasUsed, uint256 checkGas) {
        uint256 gasStart = gasleft();
        // Only runBatch ever calls this from the contract itself.
        if (msg.sender != owner && msg.sender != address(this)) revert NotOwner();
        if (targetBlock != 0 && block.number != targetBlock) revert WrongBlock();
        uint256 amount = startGap == 0 ? amountIn : _amountForGap(amountIn, hops, startGap, minGap);
        checkGas = gasStart - gasleft();

        uint256 balanceBefore = IERC20Balance(start).balanceOf(address(this));

        outs = abi.decode(MANAGER.unlock(abi.encode(start, amount, hops)), (uint256[]));

        uint256 balanceAfter = IERC20Balance(start).balanceOf(address(this));
        if (balanceAfter < balanceBefore + minProfit) revert NoProfit(balanceBefore, balanceAfter);
        profit = balanceAfter - balanceBefore;
        if (balanceAfter > 0) _transfer(start, treasury, balanceAfter);
        gasUsed = gasStart - gasleft();
    }

    /// Several routes in one transaction. The largest in a block is often the one a rival closes
    /// while smaller ones stay open, so each runs on its own and a failure undoes only itself.
    /// A transaction in which nothing worked reverts, so that it can be told apart from a win.
    function runBatch(Route[] calldata routes, uint256 targetBlock) external returns (uint256 succeeded) {
        if (msg.sender != owner) revert NotOwner();
        if (targetBlock != 0 && block.number != targetBlock) revert WrongBlock();
        for (uint256 i = 0; i < routes.length; i++) {
            Route calldata route = routes[i];
            try this.run{gas: route.gasLimit}(route.start, route.amountIn, route.hops, route.minProfit, route.startGap, route.minGap, 0) {
                succeeded++;
            } catch {}
        }
        if (succeeded == 0) revert NothingWorked();
    }

    /// Clears anything left behind, only ever to the treasury. The zero address means native ETH.
    function sweep(address token) external {
        if (msg.sender != owner) revert NotOwner();
        if (token == address(0)) {
            (bool ok, ) = treasury.call{value: address(this).balance}("");
            if (!ok) revert TransferFailed();
        } else {
            _transfer(token, treasury, IERC20Balance(token).balanceOf(address(this)));
        }
    }

    function _amountForGap(uint256 amountIn, Hop[] calldata hops, uint256 startGap, uint256 minGap) private view returns (uint256) {
        uint256 edge = ONE + startGap;
        for (uint256 i = 0; i < hops.length; i++) edge = (edge * _priceChange(hops[i])) / ONE;
        uint256 gap = edge > ONE ? edge - ONE : 0;
        if (gap < minGap || gap == 0) revert GapClosed(gap);
        uint256 limit = startGap * MAX_RESIZE;
        return (amountIn * (gap < limit ? gap : limit)) / startGap;
    }

    /// How much better this hop pays now than when decided, as a fraction of 1e18.
    function _priceChange(Hop calldata hop) private view returns (uint256) {
        if (hop.kind == KIND_V2) {
            (uint112 reserve0, uint112 reserve1, ) = IV2Pair(hop.pool).getReserves();
            (uint256 reserveIn, uint256 reserveOut) = hop.zeroForOne ? (uint256(reserve0), uint256(reserve1)) : (uint256(reserve1), uint256(reserve0));
            return (((reserveOut << 96) / reserveIn) * ONE) / hop.priceAtDecision;
        }
        // These are square roots of the price, and selling token0 pays more as its price rises.
        uint256 root = hop.kind == KIND_V3 ? _v3Price(hop.pool) : _v4Price(hop);
        uint256 change = hop.zeroForOne ? (root * ONE) / hop.priceAtDecision : (hop.priceAtDecision * ONE) / root;
        return (change * change) / ONE;
    }

    /// Reads only the first word, because V3 forks disagree about the rest of slot0.
    function _v3Price(address pool) private view returns (uint256) {
        (bool ok, bytes memory result) = pool.staticcall(abi.encodeWithSelector(0x3850c7bd));
        if (!ok || result.length < 32) revert UnknownKind();
        return uint256(uint160(abi.decode(result, (uint256))));
    }

    function _v4Price(Hop calldata hop) private view returns (uint256) {
        address currencyIn = hop.nativeLeg && hop.tokenIn == WETH ? address(0) : hop.tokenIn;
        address currencyOut = hop.nativeLeg && hop.tokenOut == WETH ? address(0) : hop.tokenOut;
        (address currency0, address currency1) = hop.zeroForOne ? (currencyIn, currencyOut) : (currencyOut, currencyIn);
        bytes32 id = keccak256(abi.encode(PoolKey(currency0, currency1, hop.fee, hop.tickSpacing, address(0))));
        return uint256(uint160(uint256(IExtsload(address(MANAGER)).extsload(keccak256(abi.encode(id, V4_POOLS_SLOT))))));
    }

    /// The manager only ever calls back whoever unlocked it, so nobody else can trigger this.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(MANAGER)) revert NotActivePool();
        (address start, uint256 amountIn, Hop[] memory hops) = abi.decode(data, (address, uint256, Hop[]));

        _borrow(start, amountIn);
        uint256[] memory outs = new uint256[](hops.length);
        uint256 amount = amountIn;
        for (uint256 i = 0; i < hops.length; i++) {
            amount = _swap(hops[i], amount);
            outs[i] = amount;
        }
        _repay(start, amountIn);
        return abi.encode(outs);
    }

    /// WETH is taken as native ETH, because that is where the manager's deep reserve sits.
    function _borrow(address token, uint256 amount) private {
        if (token == WETH) {
            MANAGER.take(address(0), address(this), amount);
            IWETH(WETH).deposit{value: amount}();
        } else {
            MANAGER.take(token, address(this), amount);
        }
    }

    function _repay(address token, uint256 amount) private {
        if (token == WETH) {
            IWETH(WETH).withdraw(amount);
            MANAGER.settle{value: amount}();
        } else {
            MANAGER.sync(token);
            _transfer(token, address(MANAGER), amount);
            MANAGER.settle();
        }
    }

    function _swap(Hop memory hop, uint256 amountIn) private returns (uint256) {
        if (hop.kind == KIND_V2) return _swapV2(hop, amountIn);
        if (hop.kind == KIND_V3) return _swapV3(hop, amountIn);
        if (hop.kind == KIND_V4) return _swapV4(hop, amountIn);
        revert UnknownKind();
    }

    function _swapV2(Hop memory hop, uint256 amountIn) private returns (uint256 amountOut) {
        (uint112 reserve0, uint112 reserve1, ) = IV2Pair(hop.pool).getReserves();
        (uint256 reserveIn, uint256 reserveOut) = hop.zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        uint256 withFee = amountIn * 997;
        amountOut = (withFee * reserveOut) / (reserveIn * 1000 + withFee);
        _transfer(hop.tokenIn, hop.pool, amountIn);
        (uint256 out0, uint256 out1) = hop.zeroForOne ? (uint256(0), amountOut) : (amountOut, uint256(0));
        IV2Pair(hop.pool).swap(out0, out1, address(this), "");
    }

    function _swapV3(Hop memory hop, uint256 amountIn) private returns (uint256) {
        activePool = hop.pool;
        activeToken = hop.tokenIn;
        activeMax = amountIn;
        (int256 amount0, int256 amount1) = IV3Pool(hop.pool).swap(address(this), hop.zeroForOne, int256(amountIn), hop.zeroForOne ? MIN_PRICE : MAX_PRICE, "");
        activePool = address(0);
        return uint256(-(hop.zeroForOne ? amount1 : amount0));
    }

    function uniswapV3SwapCallback(int256 amount0, int256 amount1, bytes calldata) external {
        _payV3(amount0, amount1);
    }

    function pancakeV3SwapCallback(int256 amount0, int256 amount1, bytes calldata) external {
        _payV3(amount0, amount1);
    }

    function _payV3(int256 amount0, int256 amount1) private {
        if (msg.sender != activePool || activePool == address(0)) revert NotActivePool();
        uint256 owed = uint256(amount0 > 0 ? amount0 : amount1);
        if (owed > activeMax) revert OwedTooMuch(owed, activeMax);
        // One payment per swap, so that a pool cannot come back for a second one.
        activePool = address(0);
        _transfer(activeToken, msg.sender, owed);
    }

    /// Runs while the manager is already unlocked by this contract's own call.
    function _swapV4(Hop memory hop, uint256 amountIn) private returns (uint256 received) {
        bool nativeIn = hop.nativeLeg && hop.tokenIn == WETH;
        bool nativeOut = hop.nativeLeg && hop.tokenOut == WETH;
        if (nativeIn) IWETH(WETH).withdraw(amountIn);
        address currencyIn = nativeIn ? address(0) : hop.tokenIn;
        address currencyOut = nativeOut ? address(0) : hop.tokenOut;
        (address currency0, address currency1) = hop.zeroForOne ? (currencyIn, currencyOut) : (currencyOut, currencyIn);

        int256 delta = MANAGER.swap(
            PoolKey(currency0, currency1, hop.fee, hop.tickSpacing, address(0)),
            SwapParams(hop.zeroForOne, -int256(amountIn), hop.zeroForOne ? MIN_PRICE : MAX_PRICE),
            ""
        );
        int128 delta0 = int128(delta >> 128);
        int128 delta1 = int128(delta);
        uint256 paid = uint256(uint128(-(hop.zeroForOne ? delta0 : delta1)));
        received = uint256(uint128(hop.zeroForOne ? delta1 : delta0));

        if (nativeIn) {
            MANAGER.settle{value: paid}();
        } else {
            MANAGER.sync(currencyIn);
            _transfer(currencyIn, address(MANAGER), paid);
            MANAGER.settle();
        }
        MANAGER.take(currencyOut, address(this), received);
        if (nativeOut) IWETH(WETH).deposit{value: received}();
    }

    /// Some tokens, USDT among them, return nothing from transfer.
    function _transfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (result.length > 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
}
