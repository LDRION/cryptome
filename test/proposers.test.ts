import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addPrediction, blockKind, newPredictionStats, predictionQuality, recipientsBySlot, registeredSlots, slotOf, type RelayEntry } from '../src/paper/proposers.ts';

const hex = (text: string): string => `0x${Buffer.from(text, 'latin1').toString('hex')}`;

test('blocks are told apart by what they sign themselves as', () => {
  assert.equal(blockKind(hex('besu 26.10.1')), 'validator');
  assert.equal(blockKind(hex('reth/v2.8.1/linux')), 'validator');
  assert.equal(blockKind(hex('Nethermind v1.39.3')), 'validator');
  assert.equal(blockKind('0xd883010f05846765746888676f312e32362e35856c696e7578'), 'validator', 'geth writes its name in binary encoding');
  assert.equal(blockKind(hex('Titan (titanbuilder.xyz)')), 'builder');
  assert.equal(blockKind(hex('BuilderNet')), 'builder');
  assert.equal(blockKind('0x'), 'blank');
  assert.equal(blockKind('0x00000000'), 'blank');
});

test('a slot number comes from the block time', () => {
  assert.equal(slotOf(1_606_824_023), 0);
  assert.equal(slotOf(1_606_824_023 + 12 * 100), 100);
});

test('a slot counts as registered when any relay lists it', () => {
  const slots = registeredSlots([[{ slot: '10' }, { slot: '11' }], [{ slot: 11 }, { slot: '12' }], []]);
  assert.deepEqual([...slots].sort((a, b) => a - b), [10, 11, 12]);
});

test('each slot keeps the address its proposer registered', () => {
  const entry = (slot: string, recipient?: string): RelayEntry => ({ slot, ...(recipient ? { entry: { message: { fee_recipient: recipient } } } : {}) });
  const recipients = recipientsBySlot([[entry('10', '0xABC'), entry('11')], [entry('12', '0xdef')]]);
  assert.equal(recipients.get(10), '0xabc');
  assert.equal(recipients.has(11), false, 'a relay entry without an address adds nothing');
  assert.equal(recipients.get(12), '0xdef');
});

test('prediction quality separates being right from catching everything', () => {
  const stats = newPredictionStats();
  addPrediction(stats, true, 'validator');
  addPrediction(stats, true, 'validator');
  addPrediction(stats, true, 'blank');
  addPrediction(stats, true, 'builder');
  addPrediction(stats, false, 'builder');
  addPrediction(stats, false, 'validator');
  const quality = predictionQuality(stats);
  assert.equal(quality.acted, 4);
  assert.equal(quality.precision, 0.75, 'three of the four predicted were really self-built');
  assert.equal(quality.recall, 0.75, 'one self-built block was missed');
});

test('no predictions gives zero quality rather than a false perfect score', () => {
  assert.deepEqual(predictionQuality(newPredictionStats()), { precision: 0, recall: 0, acted: 0 });
});
