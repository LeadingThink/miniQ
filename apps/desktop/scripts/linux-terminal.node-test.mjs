import assert from "node:assert/strict";
import test from "node:test";
import { verifyElf } from "./linux-terminal.mjs";

const base =
  "0x1 (NEEDED) Shared library: [libc.so.6]\n0x1 (NEEDED) Shared library: [libgcc_s.so.1]";

test("portable server binaries allow only baseline glibc and base runtime libraries", () => {
  assert.deepEqual(
    verifyElf(base, "Name: GLIBC_2.2.5 Name: GLIBC_2.31", "daemon"),
    {
      libraries: ["libc.so.6", "libgcc_s.so.1"],
      maximumGlibc: "2.31",
    },
  );
  assert.throws(() => verifyElf(base, "GLIBC_2.34", "daemon"), /newer/);
  assert.throws(
    () =>
      verifyElf(
        `${base}\n0x1 (NEEDED) Shared library: [libpipewire-0.3.so.0]`,
        "GLIBC_2.31",
        "daemon",
      ),
    /non-server/,
  );
  assert.throws(() => verifyElf(base, "", "daemon"), /no GLIBC/);
  assert.throws(() => verifyElf("", "GLIBC_2.31", "daemon"), /GNU\/Linux/);
});
