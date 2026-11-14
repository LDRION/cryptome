// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

interface IWethTransfer {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// A token that doubles as its own pool, built the way real attacks on bots are: its transfer
/// calls back into whoever is paying it, hoping to reach something that moves money. It exists
/// only to attack our own contract inside eth_call, and is never deployed.
///
/// It gives the money back only if every call it tried was refused, so a trade that completes
/// proves both that the attack ran and that it reached nothing.
contract EvilToken {
    address private constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    string private constant HOP = "(uint8,address,bool,address,address,uint24,int24,bool,uint256)";
    uint256 private constant ATTEMPTS = 6;

    uint256 private held;
    uint256 private refused;

    function transfer(address, uint256) external returns (bool) {
        address victim = msg.sender;
        uint256[] memory nothing = new uint256[](0);
        bytes[ATTEMPTS] memory attempts = [
            abi.encodeWithSignature("sweep(address)", WETH),
            abi.encodeWithSignature("sweep(address)", address(0)),
            abi.encodeWithSignature("uniswapV3SwapCallback(int256,int256,bytes)", int256(1e18), int256(1e18), ""),
            abi.encodeWithSignature("unlockCallback(bytes)", ""),
            abi.encodeWithSelector(bytes4(keccak256(bytes(string.concat("run(address,uint256,", HOP, "[],uint256,uint256,uint256,uint256)")))), WETH, uint256(1), nothing, uint256(0), uint256(0), uint256(0), uint256(0)),
            abi.encodeWithSelector(bytes4(keccak256(bytes(string.concat("runBatch((address,uint256,", HOP, "[],uint256,uint256,uint256,uint256)[],uint256)")))), nothing, uint256(0))
        ];
        for (uint256 i = 0; i < ATTEMPTS; i++) {
            (bool ok, ) = victim.call(attempts[i]);
            if (!ok) refused++;
        }
        return true;
    }

    function swap(address, bool zeroForOne, int256 amount, uint160, bytes calldata) external returns (int256, int256) {
        (bool paid, ) = msg.sender.call(abi.encodeWithSignature("uniswapV3SwapCallback(int256,int256,bytes)", zeroForOne ? amount : int256(0), zeroForOne ? int256(0) : amount, ""));
        require(paid, "payment failed");
        if (!zeroForOne) {
            // Took the real token and hands out its own.
            held = uint256(amount);
            return (-amount, amount);
        }
        // Took its own token, which set off the attack, and hands the real one back.
        uint256 back = refused == ATTEMPTS ? held : 0;
        require(IWethTransfer(WETH).transfer(msg.sender, back), "refund failed");
        return (amount, -int256(back));
    }
}
