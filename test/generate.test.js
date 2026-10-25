import test from "node:test";
import assert from "node:assert/strict";
import { generatePassword } from "../generate.js";

test("default: 24 chars, mixed classes, no symbols", () => {
  const p = generatePassword();
  assert.equal(p.length, 24);
  assert.match(p, /[a-z]/);
  assert.match(p, /[A-Z]/);
  assert.match(p, /[0-9]/);
  assert.match(p, /^[A-Za-z0-9]+$/);
});

test("symbols never include shell/compose-hostile characters", () => {
  for (let i = 0; i < 200; i++) {
    const p = generatePassword({ length: 40, symbols: true });
    assert.equal(p.length, 40);
    assert.doesNotMatch(p, /[$"'`\\\s]/);
    assert.match(p, /[!@#%^*\-_=+]/);
  }
});

test("rejects bad lengths", () => {
  assert.throws(() => generatePassword({ length: 8 }));
  assert.throws(() => generatePassword({ length: 500 }));
  assert.throws(() => generatePassword({ length: 20.5 }));
});

test("values differ", () => {
  assert.notEqual(generatePassword(), generatePassword());
});
