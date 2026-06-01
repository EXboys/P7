import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  advanceAccountRotation,
  orderedAccountsRoundRobin,
  peekNextAccountId,
  resetAccountRotation,
} from "../src/vcs/account-rotation.ts";

const accounts = [
  { id: "a", provider: "github" as const, auth_type: "gh" as const, gh_host: "github.com" },
  { id: "b", provider: "github" as const, auth_type: "gh" as const, gh_host: "github.com" },
  { id: "c", provider: "github" as const, auth_type: "gh" as const, gh_host: "github.com" },
];

describe("account rotation", () => {
  test("round-robin order starts at nextIndex and wraps", () => {
    const root = join(tmpdir(), `p7-rot-${Date.now()}`);
    mkdirSync(join(root, ".p7"), { recursive: true });
    try {
      resetAccountRotation(root);
      expect(peekNextAccountId(accounts, root)).toBe("a");
      let { order } = orderedAccountsRoundRobin(accounts, root);
      expect(order.map((a) => a.id)).toEqual(["a", "b", "c"]);
      advanceAccountRotation(root, "a", accounts);
      expect(peekNextAccountId(accounts, root)).toBe("b");
      ({ order } = orderedAccountsRoundRobin(accounts, root));
      expect(order.map((a) => a.id)).toEqual(["b", "c", "a"]);
      advanceAccountRotation(root, "b", accounts);
      advanceAccountRotation(root, "c", accounts);
      expect(peekNextAccountId(accounts, root)).toBe("a");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("advance ignores unknown account id", () => {
    const root = join(tmpdir(), `p7-rot-skip-${Date.now()}`);
    mkdirSync(join(root, ".p7"), { recursive: true });
    try {
      resetAccountRotation(root);
      advanceAccountRotation(root, "missing", accounts);
      expect(peekNextAccountId(accounts, root)).toBe("a");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("persists rotation state under .p7", () => {
    const root = join(tmpdir(), `p7-rot-persist-${Date.now()}`);
    mkdirSync(join(root, ".p7"), { recursive: true });
    try {
      resetAccountRotation(root);
      advanceAccountRotation(root, "a", accounts);
      expect(existsSync(join(root, ".p7", "vcs-account-rotation.json"))).toBe(true);
      expect(peekNextAccountId(accounts, root)).toBe("b");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
