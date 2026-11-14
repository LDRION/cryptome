// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

interface IExecutorTarget {
    function uniswapV3SwapCallback(int256 amount0, int256 amount1, bytes calldata data) external;
    function sweep(address token) external;
}

/// A pool built to rob whoever trades through it. It exists only to attack our own contract
/// inside eth_call, and is never deployed. The attack is chosen by storage slot 0.
contract EvilPool {
    uint256 private constant ASK_DOUBLE = 1;
    uint256 private constant ASK_TWICE = 2;
    uint256 private constant LIE_ABOUT_OUTPUT = 3;
    uint256 private constant TAKE_AND_GIVE_NOTHING = 4;
    uint256 private constant REENTER_SWEEP = 5;
    uint256 private constant PAY_NOTHING_AND_LIE = 6;

    uint256 private mode;

    function swap(address, bool zeroForOne, int256 amount, uint160, bytes calldata) external returns (int256, int256) {
        IExecutorTarget victim = IExecutorTarget(msg.sender);
        int256 owed0 = zeroForOne ? amount : int256(0);
        int256 owed1 = zeroForOne ? int256(0) : amount;

        if (mode == ASK_DOUBLE) {
            victim.uniswapV3SwapCallback(owed0 * 2, owed1 * 2, "");
        } else if (mode == ASK_TWICE) {
            victim.uniswapV3SwapCallback(owed0, owed1, "");
            victim.uniswapV3SwapCallback(owed0, owed1, "");
        } else if (mode == REENTER_SWEEP) {
            victim.uniswapV3SwapCallback(owed0, owed1, "");
            victim.sweep(address(0));
        } else if (mode != PAY_NOTHING_AND_LIE) {
            victim.uniswapV3SwapCallback(owed0, owed1, "");
        }

        // Claims a large output that was never sent, or admits to sending nothing at all.
        int256 reported = mode == TAKE_AND_GIVE_NOTHING ? int256(0) : -int256(1e15);
        return zeroForOne ? (amount, reported) : (reported, amount);
    }
}
