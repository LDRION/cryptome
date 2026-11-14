import { readFile, writeFile } from 'node:fs/promises';
import solc from 'solc';

const TARGETS = [
  { source: 'contracts/Executor.sol', name: 'Executor', out: 'contracts/Executor.json' },
  { source: 'contracts/test/EvilPool.sol', name: 'EvilPool', out: 'contracts/test/EvilPool.json' },
  { source: 'contracts/test/EvilToken.sol', name: 'EvilToken', out: 'contracts/test/EvilToken.json' },
];

const sources = {};
for (const { source } of TARGETS) sources[source] = { content: await readFile(source, 'utf8') };

const output = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: 'Solidity',
      sources,
      settings: {
        evmVersion: 'cancun',
        viaIR: true,
        optimizer: { enabled: true, runs: 1_000_000 },
        outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
      },
    }),
  ),
);

const problems = (output.errors ?? []).filter((entry) => entry.severity === 'error');
if (problems.length > 0) {
  for (const problem of problems) console.error(problem.formattedMessage);
  process.exitCode = 1;
} else {
  for (const warning of output.errors ?? []) console.error(warning.formattedMessage);
  for (const { source, name, out } of TARGETS) {
    const contract = output.contracts[source][name];
    await writeFile(out, JSON.stringify({ abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}`, deployedBytecode: `0x${contract.evm.deployedBytecode.object}` }, null, 2) + '\n');
    console.log(`${name} compiled: ${contract.evm.deployedBytecode.object.length / 2} bytes`);
  }
}
