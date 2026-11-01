// Calldata and permissions for the owner's controls. No dependencies, so the page loads nothing from outside this server,
// and no keys: the visitor's own wallet signs, after it has shown them the transaction. A test checks every encoding
// against viem, byte for byte.

const SELECTORS = {
  pause: '0x8456cb59',
  unpause: '0x3f4ba83a',
  halt: '0x5ed7ca5b',
  revokeAgent: '0x7961803e',
  disarmStop: '0x865c1974',
  withdraw: '0xd9caed12',
  setAgent: '0xa9aa177a',
};
const SHAPES = { pause: [], unpause: [], halt: [], revokeAgent: [], disarmStop: [], withdraw: ['address', 'address', 'uint256'], setAgent: ['address', 'uint256'] };
const UINT_MAX = (1n << 256n) - 1n;

// Keccak-256, for the address checksum: a mistyped mixed-case address must not become a real withdrawal.
const ROUND = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROTATE = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const SWAP = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const MASK = (1n << 64n) - 1n;
const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK;
function keccakF(a) {
  for (const rc of ROUND) {
    const c = [0, 1, 2, 3, 4].map((x) => a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]);
    for (let x = 0; x < 5; x++) { const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) a[x + y] ^= d; }
    let last = a[1];
    SWAP.forEach((to, i) => { const next = a[to]; a[to] = rotl(last, ROTATE[i]); last = next; });
    for (let y = 0; y < 25; y += 5) { const row = a.slice(y, y + 5); for (let x = 0; x < 5; x++) a[y + x] = row[x] ^ (~row[(x + 1) % 5] & MASK & row[(x + 2) % 5]); }
    a[0] ^= rc;
  }
}
function keccakHex(text) {
  const RATE = 136;
  const bytes = [...text].map((ch) => ch.charCodeAt(0));
  bytes.push(1);
  while (bytes.length % RATE) bytes.push(0);
  bytes[bytes.length - 1] |= 0x80;
  const a = Array(25).fill(0n);
  for (let at = 0; at < bytes.length; at += RATE) {
    for (let i = 0; i < RATE / 8; i++) { let lane = 0n; for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(bytes[at + i * 8 + b]); a[i] ^= lane; }
    keccakF(a);
  }
  let hex = '';
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) hex += ((a[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, '0');
  return hex;
}

/** EIP-55. All one case carries no checksum and passes; mixed case must be right. */
export function checksumOk(address) {
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const hash = keccakHex(body.toLowerCase());
  return [...body].every((ch, i) => (/[0-9]/.test(ch) ? true : parseInt(hash[i], 16) >= 8 ? ch === ch.toUpperCase() : ch === ch.toLowerCase()));
}

const word = (type, value) => {
  if (type === 'address') {
    if (typeof value !== 'string' || !/^0x[\da-fA-F]{40}$/.test(value)) throw new Error('That is not an address.');
    if (!checksumOk(value)) throw new Error('That address has a bad checksum, so it may be mistyped.');
    return value.slice(2).toLowerCase().padStart(64, '0');
  }
  if (typeof value !== 'bigint' || value < 0n || value > UINT_MAX) throw new Error('That is not an amount.');
  return value.toString(16).padStart(64, '0');
};

export function encodeCall(name, args) {
  const shape = SHAPES[name];
  if (!shape || !Object.hasOwn(SHAPES, name)) throw new Error(`No such control: ${name}`);
  if (args.length !== shape.length) throw new Error(`${name} takes ${shape.length} arguments.`);
  return SELECTORS[name] + shape.map((type, i) => word(type, args[i])).join('');
}

/** A decimal string to base units, exactly. Refuses what it would have to round. */
export function parseAmount(text, decimals) {
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error('Enter a plain number.');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new Error(`This token has ${decimals} decimals.`);
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export function roleOf(address, vault) {
  if (same(address, vault.owner)) return 'owner';
  if (same(address, vault.guardian)) return 'guardian';
  if (same(address, vault.agent)) return 'agent';
  return 'none';
}

const CONTROLS = [
  { id: 'pause', call: 'pause', label: 'Pause trading', roles: ['owner', 'guardian', 'agent'], note: 'The agent cannot trade until the owner unpauses. The owner can still withdraw.' },
  { id: 'unpause', call: 'unpause', label: 'Unpause', roles: ['owner'], note: 'The agent can trade again, inside its limits.' },
  { id: 'revoke', call: 'revokeAgent', label: 'End the agent key', roles: ['owner', 'guardian'], v3: true, note: 'The key stops working at once. Only the owner can name a new one.' },
  { id: 'halt', call: 'halt', label: 'Halt everything', roles: ['owner', 'guardian'], v3: true, note: 'Pauses trading and disarms the stop, in one call. The owner can still withdraw.' },
  { id: 'disarm', call: 'disarmStop', label: 'Disarm the stop', roles: ['owner', 'guardian'], v3: true, note: 'The price stop no longer fires.' },
  { id: 'renew', call: 'setAgent', label: 'Set the agent key', roles: ['owner'], v3: true, form: 'agent', note: 'Names the agent key and its expiry, which can be at most 30 days away.' },
  { id: 'withdraw', call: 'withdraw', label: 'Withdraw', roles: ['owner'], form: 'withdraw', note: 'Sends tokens from the vault. This works even when the vault is halted.' },
];

/** Which controls to offer. The vault decides in the end; this only keeps the page from offering what would be refused. */
export function controlsFor(role, version) {
  return CONTROLS.filter((c) => c.roles.includes(role) && (!c.v3 || (version ?? 0) >= 3));
}
