export type Asset = 'USD' | 'ETH' | 'BTC' | 'BNB' | 'NATIVE';

export interface Chain {
  name: string;
  defaultRpc: string;
  defaultTraceRpc?: string;
  /** Serves eth_getLogs filtered by topic alone, which many public nodes refuse. */
  defaultLogsRpc?: string;
  wrappedNative: string;
  nativeAsset: Asset;
  bnbFeed?: string;
  /** Prices a native coin with no feed. A current spot price, so for screening only. */
  coingeckoId?: string;
  tokens: Record<string, Asset>;
}

const lowerKeys = (tokens: Record<string, Asset>): Record<string, Asset> =>
  Object.fromEntries(Object.entries(tokens).map(([address, asset]) => [address.toLowerCase(), asset]));

/** Addresses are checked against the chain when a scan starts, and bad ones are dropped. */
const screened = (name: string, rpc: string, wrappedNative: string, nativeAsset: Asset, tokens: Record<string, Asset>, coingeckoId?: string): Chain => ({
  name,
  defaultRpc: rpc,
  defaultTraceRpc: `https://${name}.drpc.org`,
  wrappedNative: wrappedNative.toLowerCase(),
  nativeAsset,
  ...(coingeckoId ? { coingeckoId } : {}),
  tokens: lowerKeys(tokens),
});

const OP_WETH = '0x4200000000000000000000000000000000000006';

export const SCREENED_CHAINS: Record<string, Chain> = {
  optimism: screened('optimism', 'https://optimism-rpc.publicnode.com', OP_WETH, 'ETH', {
    [OP_WETH]: 'ETH',
    '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85': 'USD',
    '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58': 'USD',
    '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1': 'USD',
    '0x68f180fcCe6836688e9084f035309E29Bf0A2095': 'BTC',
  }),
  polygon: screened('polygon', 'https://polygon-bor-rpc.publicnode.com', '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', 'NATIVE', {
    '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270': 'NATIVE',
    '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359': 'USD',
    '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174': 'USD',
    '0xc2132D05D31c914a87C6611C10748AEb04B58e8F': 'USD',
    '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619': 'ETH',
    '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6': 'BTC',
  }, 'polygon-ecosystem-token'),
  avalanche: screened('avalanche', 'https://avalanche-c-chain-rpc.publicnode.com', '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', 'NATIVE', {
    '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7': 'NATIVE',
    '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E': 'USD',
    '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7': 'USD',
    '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB': 'ETH',
    '0x152b9d0FdC40C096757F570A51E494bd4b943E50': 'BTC',
  }, 'avalanche-2'),
  gnosis: screened('gnosis', 'https://gnosis-rpc.publicnode.com', '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', 'USD', {
    '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d': 'USD',
    '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83': 'USD',
    '0x4ECaBa5870353805a9F068101A40E0f32ed605C6': 'USD',
    '0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1': 'ETH',
  }),
  scroll: screened('scroll', 'https://scroll-rpc.publicnode.com', '0x5300000000000000000000000000000000000004', 'ETH', {
    '0x5300000000000000000000000000000000000004': 'ETH',
    '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4': 'USD',
    '0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df': 'USD',
  }),
  mantle: screened('mantle', 'https://mantle-rpc.publicnode.com', '0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8', 'NATIVE', {
    '0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8': 'NATIVE',
    '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9': 'USD',
    '0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE': 'USD',
    '0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111': 'ETH',
  }, 'mantle'),
  blast: screened('blast', 'https://blast-rpc.publicnode.com', '0x4300000000000000000000000000000000000004', 'ETH', {
    '0x4300000000000000000000000000000000000004': 'ETH',
    '0x4300000000000000000000000000000000000003': 'USD',
  }),
  celo: screened('celo', 'https://forno.celo.org', '0x471EcE3750Da237f93B8E339c536989b8978a438', 'NATIVE', {
    '0x471EcE3750Da237f93B8E339c536989b8978a438': 'NATIVE',
    '0xcebA9300f2b948710d2653dD7B07f33A8B32118C': 'USD',
    '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e': 'USD',
  }, 'celo'),
  sonic: screened('sonic', 'https://sonic-rpc.publicnode.com', '0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38', 'NATIVE', {
    '0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38': 'NATIVE',
    '0x29219dd400f2Bf60E5a23d13Be72B486D4038894': 'USD',
    '0x50c42dEAcD8Fc9773493ED674b675bE577f2634b': 'ETH',
  }, 'sonic-3'),
  berachain: screened('berachain', 'https://berachain-rpc.publicnode.com', '0x6969696969696969696969696969696969696969', 'NATIVE', {
    '0x6969696969696969696969696969696969696969': 'NATIVE',
    '0x549943e04f40284185054145c6E4e9568C1D3241': 'USD',
    '0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590': 'ETH',
  }, 'berachain-bera'),
  hyperliquid: screened('hyperliquid', 'https://rpc.hyperliquid.xyz/evm', '0x5555555555555555555555555555555555555555', 'NATIVE', {
    '0x5555555555555555555555555555555555555555': 'NATIVE',
    '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb': 'USD',
    '0xBe6727B535545C67d5cAa73dEa54865B92CF7907': 'ETH',
  }, 'hyperliquid'),
  zksync: screened('zksync', 'https://mainnet.era.zksync.io', '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91', 'ETH', {
    '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91': 'ETH',
    '0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4': 'USD',
    '0x493257fD37EDB34451f62EDf8D2a0C418852bA4C': 'USD',
  }),
  worldchain: screened('worldchain', 'https://worldchain-mainnet.g.alchemy.com/public', OP_WETH, 'ETH', {
    [OP_WETH]: 'ETH',
    '0x79A02482A880bCE3F13e09Da970dC34db4CD24d1': 'USD',
  }),
  ink: screened('ink', 'https://rpc-gel.inkonchain.com', OP_WETH, 'ETH', {
    [OP_WETH]: 'ETH',
    '0x0200C29006150606B650577BBE7B6248F58470c1': 'USD',
  }),
  plasma: screened('plasma', 'https://rpc.plasma.to', '0x6100E367285b01F48D07953803A2d8dCA5D19873', 'NATIVE', {
    '0x6100E367285b01F48D07953803A2d8dCA5D19873': 'NATIVE',
    '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb': 'USD',
  }, 'plasma'),
};

/** ETH and BTC are read from these Base feeds for every chain, since Base serves archive calls. */
export const PRICE_FEEDS = {
  rpc: 'https://mainnet.base.org',
  blockTimeSeconds: 2,
  ETH: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
  BTC: '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F',
};

export const CHAINS: Record<string, Chain> = {
  base: {
    name: 'base',
    defaultRpc: 'https://mainnet.base.org',
    defaultTraceRpc: 'https://base.drpc.org',
    wrappedNative: '0x4200000000000000000000000000000000000006',
    nativeAsset: 'ETH',
    tokens: lowerKeys({
      '0x4200000000000000000000000000000000000006': 'ETH',
      '0x833589fCD6eDb6E08f4C7C32D4f71b54bdA02913': 'USD',
      '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA': 'USD',
      '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2': 'USD',
      '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb': 'USD',
      '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf': 'BTC',
    }),
  },
  arbitrum: {
    name: 'arbitrum',
    defaultRpc: 'https://arb1.arbitrum.io/rpc',
    defaultTraceRpc: 'https://arbitrum.drpc.org',
    wrappedNative: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
    nativeAsset: 'ETH',
    tokens: lowerKeys({
      '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1': 'ETH',
      '0xaf88d065e77c8cC2239327C5EDb3A432268e5831': 'USD',
      '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8': 'USD',
      '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9': 'USD',
      '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1': 'USD',
      '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f': 'BTC',
    }),
  },
  ethereum: {
    name: 'ethereum',
    defaultRpc: 'https://ethereum-rpc.publicnode.com',
    defaultTraceRpc: 'https://eth.drpc.org',
    defaultLogsRpc: 'https://rpc.mevblocker.io',
    wrappedNative: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    nativeAsset: 'ETH',
    tokens: lowerKeys({
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': 'ETH',
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': 'USD',
      '0xdAC17F958D2ee523a2206206994597C13D831ec7': 'USD',
      '0x6B175474E89094C44Da98b954EedeAC495271d0F': 'USD',
      '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599': 'BTC',
    }),
  },
  unichain: {
    name: 'unichain',
    defaultRpc: 'https://unichain-rpc.publicnode.com',
    defaultTraceRpc: 'https://unichain.drpc.org',
    wrappedNative: '0x4200000000000000000000000000000000000006',
    nativeAsset: 'ETH',
    tokens: lowerKeys({
      '0x4200000000000000000000000000000000000006': 'ETH',
      '0x078D782b760474a361dDA0AF3839290b0EF57AD6': 'USD',
      '0x9151434b16b9763660705744891fA906F660EcC5': 'USD',
      '0x20CAb320A855b39F724131C69424240519573f81': 'USD',
      '0x927B51f251480a681271180DA4de28D44EC4AfB8': 'BTC',
    }),
  },
  linea: {
    name: 'linea',
    defaultRpc: 'https://linea-rpc.publicnode.com',
    defaultTraceRpc: 'https://linea.drpc.org',
    wrappedNative: '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f',
    nativeAsset: 'ETH',
    tokens: lowerKeys({
      '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f': 'ETH',
      '0x176211869cA2b568f2A7D4EE941E073a821EE1ff': 'USD',
      '0xA219439258ca9da29E9Cc4cE5596924745e12B93': 'USD',
      '0x4AF15ec2A0BD43Db75dd04E62FAA3B8EF36b00d5': 'USD',
      '0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4': 'BTC',
    }),
  },
  bsc: {
    name: 'bsc',
    defaultRpc: 'https://bsc-rpc.publicnode.com',
    defaultTraceRpc: 'https://bsc.drpc.org',
    wrappedNative: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    nativeAsset: 'BNB',
    bnbFeed: '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE',
    tokens: lowerKeys({
      '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c': 'BNB',
      '0x55d398326f99059fF775485246999027B3197955': 'USD',
      '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d': 'USD',
      '0x2170Ed0880ac9A755fd29B2688956BD959F933F8': 'ETH',
      '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c': 'BTC',
    }),
  },
};

/**
 * Plain ERC-20s the emulator may route through on Ethereum. Fee-on-transfer and rebasing
 * tokens stay out, since pool logs cannot reveal what a trader actually receives.
 */
export const ETHEREUM_VETTED_TOKENS: Record<string, string> = {
  WETH: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  DAI: '0x6b175474e89094c44da98b954eedeac495271d0f',
  WBTC: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
  cbBTC: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
  wstETH: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0',
  weETH: '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee',
  LINK: '0x514910771af9ca656af840dff83e8264ecf986ca',
  UNI: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
  AAVE: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9',
  USDe: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
  crvUSD: '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e',
  PEPE: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
};

export const chainNamed = (name: string): Chain | undefined => CHAINS[name] ?? SCREENED_CHAINS[name];

export function rpcUrlFor(chain: Chain): string {
  const specific = process.env[`RPC_URL_${chain.name.toUpperCase()}`];
  if (specific) return specific;
  if (chain.name === 'base' && process.env.RPC_URL) return process.env.RPC_URL;
  return chain.defaultRpc;
}
