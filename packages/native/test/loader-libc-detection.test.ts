// The loader picks the -musl or -gnu prebuild from the host's libc. It must decide that from the
// running process and fixed filesystem paths only: it is shipped runtime code, so resolving an
// executable through PATH (`ldd --version`) would run whatever a writable PATH directory offers.
// These tests evaluate the real index.js against a fake Linux host and record what it asks for.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import { describe, expect, it } from "vitest";

const LOADER = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const SOURCE = readFileSync(LOADER, "utf8");
const realRequire = createRequire(import.meta.url);

interface Host {
  /** process.report.getReport() result; undefined = no report API at all. */
  report?: unknown;
  /** Text of /usr/bin/ldd; undefined = unreadable. */
  lddScript?: string;
  /** Directory listings by absolute path; a missing key is an unreadable directory. */
  dirs?: Record<string, string[]>;
}

/** Evaluate index.js on a fake linux/x64 host. Returns every module id it required. */
function loadOn(host: Host): { required: string[] } {
  const required: string[] = [];
  const fakeFs = {
    existsSync: () => false,
    readFileSync: (p: string) => {
      if (p === "/usr/bin/ldd" && host.lddScript !== undefined) return host.lddScript;
      throw new Error(`ENOENT: ${p}`);
    },
    readdirSync: (p: string) => {
      const names = host.dirs?.[p];
      if (names === undefined) throw new Error(`ENOENT: ${p}`);
      return names;
    },
  };
  const fakeRequire = (id: string): unknown => {
    required.push(id);
    if (id === "node:fs") return fakeFs;
    if (id === "node:path") return realRequire("node:path");
    if (id === "./fallback.js") return {};
    throw new Error(`not available on the fake host: ${id}`);
  };
  const fakeProcess = {
    platform: "linux",
    arch: "x64",
    ...(host.report === undefined ? {} : { report: { getReport: () => host.report } }),
  };
  const mod = { exports: {} };
  compileFunction(SOURCE, ["require", "module", "exports", "process", "__dirname"], {
    filename: LOADER,
  })(fakeRequire, mod, mod.exports, fakeProcess, "/fake/native");
  return { required };
}

const prebuild = (required: string[]): string | undefined =>
  required.find((id) => id.startsWith("@the-40-thieves/reliquary-tc-native-"));
const spawned = (required: string[]): boolean =>
  required.some((id) => id === "node:child_process" || id === "child_process");

describe("native loader libc detection", () => {
  it("never loads child_process, whatever the probes say", () => {
    const hosts: Host[] = [
      {},
      { report: null },
      { report: { header: {}, sharedObjects: [] } },
      { lddScript: "#!/bin/sh\n# glibc" },
      { dirs: { "/lib": ["ld-musl-x86_64.so.1"] } },
    ];
    for (const host of hosts)
      expect(spawned(loadOn(host).required), JSON.stringify(host)).toBe(false);
  });

  it("a host with no report and no /usr/bin/ldd is musl when the musl loader is in /lib", () => {
    const { required } = loadOn({ dirs: { "/lib": ["libc.so.6", "ld-musl-x86_64.so.1"] } });
    expect(prebuild(required)).toBe("@the-40-thieves/reliquary-tc-native-linux-x64-musl");
  });

  it("the same host without a musl loader takes the glibc prebuild", () => {
    const { required } = loadOn({ dirs: { "/lib": ["libc.so.6"], "/usr/lib": [] } });
    expect(prebuild(required)).toBe("@the-40-thieves/reliquary-tc-native-linux-x64-gnu");
  });

  it("nothing readable at all defaults to glibc", () => {
    expect(prebuild(loadOn({}).required)).toBe("@the-40-thieves/reliquary-tc-native-linux-x64-gnu");
  });

  it("the process report decides first: glibc runtime wins over a musl loader on disk", () => {
    const { required } = loadOn({
      report: { header: { glibcVersionRuntime: "2.39" }, sharedObjects: [] },
      dirs: { "/lib": ["ld-musl-x86_64.so.1"] },
    });
    expect(prebuild(required)).toBe("@the-40-thieves/reliquary-tc-native-linux-x64-gnu");
  });

  it("a report listing the musl loader is musl", () => {
    const { required } = loadOn({
      report: { header: {}, sharedObjects: ["/lib/ld-musl-x86_64.so.1"] },
    });
    expect(prebuild(required)).toBe("@the-40-thieves/reliquary-tc-native-linux-x64-musl");
  });

  it("/usr/bin/ldd text decides when the report does not", () => {
    expect(prebuild(loadOn({ lddScript: "musl libc (x86_64)" }).required)).toBe(
      "@the-40-thieves/reliquary-tc-native-linux-x64-musl",
    );
    expect(
      prebuild(
        loadOn({ lddScript: "#!/bin/bash\n# GNU", dirs: { "/lib": ["ld-musl-x86_64.so.1"] } })
          .required,
      ),
    ).toBe("@the-40-thieves/reliquary-tc-native-linux-x64-gnu");
  });
});
