// Card T19-CC-BND-V4 (Michael rev120, picks :3446: "Yes, merge and tag v4 (Recommended)"): v4 of
// the shared deploy workflow can publish without deploying (`deploy: false`), returns the pushed
// digest, and needs AZURE_CREDENTIALS only when it deploys. Callers written for v2/v3 pass no
// `deploy` input and must behave exactly as before.
//
// The file is read as YAML, and every step `if` is evaluated for a set of caller inputs, so the
// census checks which steps RUN, not how the lines are spelled.
//
// This repo had no deno config and no deps before this card. The two std packages are pinned at
// exact versions in deno.jsonc, at the versions ftm-relay-gatekeeper pins them (deno lint's
// no-import-prefix refuses an inline jsr: pin).
import { assert, assertEquals, assertThrows } from "@std/assert";
import { parse } from "@std/yaml";

type Step = {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};

type Input = {
  type: string;
  default?: unknown;
  required?: boolean;
  description?: string;
};

type Workflow = {
  on: {
    workflow_call: {
      inputs: Record<string, Input>;
      secrets: Record<string, { required: boolean }>;
      outputs?: Record<string, { value: string }>;
    };
  };
  jobs: Record<
    string,
    { outputs?: Record<string, string>; steps: Step[]; env?: unknown }
  >;
};

const JOB = "build-and-push";

const AZURE_LOGIN = "azure/login@v2";
const WEBAPPS_DEPLOY = "azure/webapps-deploy@v3";
const BUILD_PUSH = "docker/build-push-action@v6";

const DEPLOY_ONLY = "${{ !inputs.warm-only && inputs.deploy }}";

const CHECK_STEP = "Check the Azure credentials";
const RECORD_STEP = "Record the digest";

/**
 * Every step v3 (a2c82f4, also b29559d) had, in order, with its `uses` and its `if` exactly as v3
 * wrote it. v4 must keep each one, with the same `uses`, and for a caller that passes no `deploy`
 * each must run or skip exactly as v3's own `if` says.
 */
const V3_STEPS: { name: string; uses?: string; if?: string }[] = [
  { name: "Checkout the repository", uses: "actions/checkout@v4" },
  {
    name: "Check the extra checkout request",
    if: "inputs.extra-repository != ''",
  },
  {
    name: "Mint a read token for the extra repository",
    uses: "actions/create-github-app-token@v2",
    if: "inputs.extra-repository != '' && inputs.extra-app-id != ''",
  },
  {
    name: "Checkout the extra repository",
    uses: "actions/checkout@v4",
    if: "inputs.extra-repository != ''",
  },
  {
    name: "Deno Setup",
    uses: "denoland/setup-deno@v2",
    if: "inputs.test-task != ''",
  },
  { name: "Test", if: "inputs.test-task != ''" },
  { name: "Set up Docker Buildx", uses: "docker/setup-buildx-action@v3" },
  {
    name: "Login via Azure CLI",
    uses: AZURE_LOGIN,
    if: "${{ !inputs.warm-only }}",
  },
  {
    name: "Login to Azure Container Registry",
    uses: "azure/docker-login@v1",
  },
  { name: "Build the Docker image", uses: BUILD_PUSH },
  {
    name: "Deploy to Web App for Containers",
    uses: WEBAPPS_DEPLOY,
    if: "${{ !inputs.warm-only }}",
  },
];

async function load(): Promise<Workflow> {
  const text = await Deno.readTextFile(
    new URL("../.github/workflows/deploy.yml", import.meta.url),
  );
  return parse(text) as Workflow;
}

function steps(wf: Workflow): Step[] {
  return wf.jobs[JOB].steps;
}

function stepNamed(wf: Workflow, name: string): Step {
  const found = steps(wf).filter((s) => s.name === name);
  assertEquals(found.length, 1, `exactly one step named "${name}"`);
  return found[0];
}

function stepUsing(wf: Workflow, uses: string): Step {
  const found = steps(wf).filter((s) => s.uses === uses);
  assertEquals(found.length, 1, `exactly one step using ${uses}`);
  return found[0];
}

type Values = Record<string, string | boolean>;

/** The caller's inputs with the workflow's defaults filled in, as GitHub does. */
function withDefaults(wf: Workflow, given: Values): Values {
  const out: Values = {};
  for (const [name, input] of Object.entries(wf.on.workflow_call.inputs)) {
    if (name in given) out[name] = given[name];
    else if (input.default !== undefined) {
      out[name] = input.default as string | boolean;
    } else out[name] = input.type === "boolean" ? false : "";
  }
  for (const name of Object.keys(given)) {
    assert(name in out, `the workflow takes an input named "${name}"`);
  }
  return out;
}

/**
 * Evaluates the step `if` forms this file uses: terms joined by `&&`, each `inputs.x`,
 * `!inputs.x`, `inputs.x != ''` or `inputs.x == ''`. Anything else throws, so a new form has to
 * be taught here on purpose rather than silently read as true.
 */
function runs(cond: string | undefined, values: Values): boolean {
  if (cond === undefined) return true;
  let body = cond.trim();
  const wrapped = /^\$\{\{(.*)\}\}$/s.exec(body);
  if (wrapped) body = wrapped[1].trim();
  return body.split("&&").every((raw) => {
    const term = raw.trim();
    let m = /^(!?)inputs\.([A-Za-z0-9_-]+)$/.exec(term);
    if (m) {
      assert(m[2] in values, `the if reads a real input: ${m[2]}`);
      const v = values[m[2]];
      assertEquals(typeof v, "boolean", `inputs.${m[2]} is a boolean`);
      return m[1] === "!" ? !v : v as boolean;
    }
    m = /^inputs\.([A-Za-z0-9_-]+)\s*(!=|==)\s*''$/.exec(term);
    if (m) {
      assert(m[1] in values, `the if reads a real input: ${m[1]}`);
      const empty = values[m[1]] === "";
      return m[2] === "==" ? empty : !empty;
    }
    throw new Error(`unknown if form: ${term}`);
  });
}

/** The names of the steps that run for these caller inputs. */
function running(wf: Workflow, given: Values): string[] {
  const values = withDefaults(wf, given);
  return steps(wf).filter((s) => runs(s.if, values)).map((s) => s.name ?? "");
}

const CALLERS: Values[] = [
  { "app-name": "open-industrial-api-runtime" },
  { "app-name": "open-industrial-api-runtime", "image-tag": "integration" },
  { "app-name": "open-industrial-web-runtime", "test-task": "test" },
  { "app-name": "open-industrial-web-runtime", "warm-only": true },
  {
    "app-name": "x",
    "extra-repository": "fathym/x",
    "extra-ref": "main",
    "extra-path": "x",
  },
  {
    "app-name": "x",
    "extra-repository": "fathym/x",
    "extra-ref": "main",
    "extra-path": "x",
    "extra-app-id": "1",
  },
];

Deno.test("the evaluator: near misses", () => {
  const v = { a: true, b: false, s: "", t: "x" };
  assertEquals(runs("${{ !inputs.b && inputs.a }}", v), true);
  assertEquals(runs("${{ !inputs.a && inputs.a }}", v), false);
  assertEquals(runs("${{ !inputs.b && inputs.b }}", v), false);
  assertEquals(runs("inputs.t != ''", v), true);
  assertEquals(runs("inputs.s != ''", v), false);
  assertEquals(runs("inputs.s == ''", v), true);
  assertThrows(() => runs("inputs.a || inputs.b", v));
  assertThrows(() => runs("secrets.X != ''", v));
  assertThrows(() => runs("inputs.missing", v));
});

Deno.test("deploy is a boolean input that defaults to true", async () => {
  const wf = await load();
  const deploy = wf.on.workflow_call.inputs.deploy;
  assert(deploy, "an input named deploy");
  assertEquals(deploy.type, "boolean");
  assertEquals(deploy.default, true);
  assert(!deploy.required, "deploy is optional");
});

Deno.test("app-name is described as the image path and the Web App name", async () => {
  const wf = await load();
  assertEquals(
    wf.on.workflow_call.inputs["app-name"].description,
    "the ACR image path (may hold slashes, e.g. fathym/prerelease/<repo>); also the Web App name when deploy is true",
  );
});

Deno.test("AZURE_CREDENTIALS is optional; the three ACR secrets stay required", async () => {
  const wf = await load();
  const secrets = wf.on.workflow_call.secrets;
  assertEquals(secrets.AZURE_CREDENTIALS.required, false);
  for (const name of ["ACR_REGISTRY", "ACR_USERNAME", "ACR_PASSWORD"]) {
    assertEquals(secrets[name].required, true, name);
  }
});

Deno.test("azure/login and webapps-deploy run only when deploying", async () => {
  const wf = await load();
  assertEquals(stepUsing(wf, AZURE_LOGIN).if, DEPLOY_ONLY);
  assertEquals(stepUsing(wf, WEBAPPS_DEPLOY).if, DEPLOY_ONLY);
});

Deno.test("deploy: false builds and pushes, and signs in to and deploys nothing", async () => {
  const wf = await load();
  const ran = running(wf, { "app-name": "fathym/prerelease/x", deploy: false });
  for (
    const name of [
      "Checkout the repository",
      "Set up Docker Buildx",
      "Login to Azure Container Registry",
      "Build the Docker image",
      RECORD_STEP,
    ]
  ) assert(ran.includes(name), `runs: ${name}`);
  for (
    const name of [
      CHECK_STEP,
      "Login via Azure CLI",
      "Deploy to Web App for Containers",
    ]
  ) assert(!ran.includes(name), `skips: ${name}`);
  const build = stepUsing(wf, BUILD_PUSH);
  assertEquals(build.with?.push, "${{ !inputs.warm-only }}");

  // Near miss: the same caller with deploy left at its default signs in and deploys.
  const deployed = running(wf, { "app-name": "x" });
  assert(deployed.includes("Login via Azure CLI"));
  assert(deployed.includes("Deploy to Web App for Containers"));
});

Deno.test("AZURE_CREDENTIALS is read only by steps that run only when deploying", async () => {
  const wf = await load();
  const job = wf.jobs[JOB];
  assertEquals(
    job.env,
    undefined,
    "no job-level env (it would read secrets on every run)",
  );
  const readers = steps(wf).filter((s) =>
    JSON.stringify(s).includes("secrets.AZURE_CREDENTIALS")
  );
  assertEquals(
    readers.map((s) => s.name),
    [CHECK_STEP, "Login via Azure CLI"],
  );
  for (const s of readers) {
    const values = withDefaults(wf, { "app-name": "x", deploy: false });
    assertEquals(
      runs(s.if, values),
      false,
      `${s.name} skips with deploy: false`,
    );
  }
});

Deno.test("an empty AZURE_CREDENTIALS fails by name when deploying", async () => {
  const wf = await load();
  const check = stepNamed(wf, CHECK_STEP);
  // Secrets cannot be read in an `if` (GitHub docs, "Using secrets in GitHub Actions"), so the
  // step gets it as env and tests it in the shell.
  assertEquals(check.if, DEPLOY_ONLY);
  assertEquals(
    check.env?.AZURE_CREDENTIALS,
    "${{ secrets.AZURE_CREDENTIALS }}",
  );
  assert(check.run?.includes('[ -n "$AZURE_CREDENTIALS" ]'), check.run);
  assert(check.run?.includes("::error::AZURE_CREDENTIALS is empty"), check.run);
  assert(check.run?.includes("exit 1"), check.run);
  // It runs before anything is built, so a missing secret costs seconds, not a build.
  const names = steps(wf).map((s) => s.name);
  assert(names.indexOf(CHECK_STEP) < names.indexOf("Build the Docker image"));
  assert(names.indexOf(CHECK_STEP) < names.indexOf("Login via Azure CLI"));
});

Deno.test("the digest output is wired from the build step", async () => {
  const wf = await load();
  const build = stepUsing(wf, BUILD_PUSH);
  assertEquals(build.id, "build");
  const job = wf.jobs[JOB];
  assertEquals(job.outputs?.digest, "${{ steps.build.outputs.digest }}");
  assertEquals(
    wf.on.workflow_call.outputs?.digest?.value,
    `\${{ jobs.${JOB}.outputs.digest }}`,
  );

  // Every step id a job output names is a real step id in that job (near miss: a typo'd id
  // would give callers an empty digest with no error).
  const ids = steps(wf).map((s) => s.id).filter((id) => id);
  for (const [name, value] of Object.entries(job.outputs ?? {})) {
    for (const m of value.matchAll(/steps\.([A-Za-z0-9_-]+)\./g)) {
      assert(ids.includes(m[1]), `output ${name} names step id ${m[1]}`);
    }
  }
  // And every job the workflow output names exists.
  for (const [name, out] of Object.entries(wf.on.workflow_call.outputs ?? {})) {
    for (const m of out.value.matchAll(/jobs\.([A-Za-z0-9_-]+)\./g)) {
      assert(m[1] in wf.jobs, `workflow output ${name} names job ${m[1]}`);
    }
  }
});

Deno.test("the digest is recorded with the path and version, not the registry host", async () => {
  const wf = await load();
  const record = stepNamed(wf, RECORD_STEP);
  assertEquals(record.if, "${{ !inputs.warm-only }}");
  assertEquals(record.env?.APP_NAME, "${{ inputs.app-name }}");
  assertEquals(record.env?.IMAGE_TAG, "${{ inputs.image-tag }}");
  assertEquals(record.env?.DIGEST, "${{ steps.build.outputs.digest }}");
  const line = "path=${APP_NAME} version=${IMAGE_TAG} digest=${DIGEST}";
  assert(record.run?.includes(line), record.run);
  assert(record.run?.includes("$GITHUB_STEP_SUMMARY"), record.run);
  assert(!JSON.stringify(record).includes("ACR_REGISTRY"), "no registry host");
  const names = steps(wf).map((s) => s.name);
  assert(names.indexOf(RECORD_STEP) > names.indexOf("Build the Docker image"));
  assert(
    names.indexOf(RECORD_STEP) <
      names.indexOf("Deploy to Web App for Containers"),
    "recorded before the deploy, so a failed deploy still shows what was pushed",
  );
  // Near miss: a warm-only run pushes nothing, so it records nothing.
  assert(
    !running(wf, { "app-name": "x", "warm-only": true }).includes(RECORD_STEP),
  );
});

Deno.test("every v3 step is still there, in order, with the same uses", async () => {
  const wf = await load();
  const v4 = steps(wf).filter((s) => V3_STEPS.some((o) => o.name === s.name));
  assertEquals(
    v4.map((s) => ({ name: s.name, uses: s.uses })),
    V3_STEPS.map((s) => ({ name: s.name, uses: s.uses })),
  );
  // The only steps v4 adds are the two named here.
  const added = steps(wf).filter((s) =>
    !V3_STEPS.some((o) => o.name === s.name)
  );
  assertEquals(added.map((s) => s.name), [CHECK_STEP, RECORD_STEP]);
});

Deno.test("a v2/v3 caller (no deploy input) runs exactly the steps v3 ran", async () => {
  const wf = await load();
  for (const caller of CALLERS) {
    const values = withDefaults(wf, caller);
    const ranV3 = V3_STEPS.filter((s) => runs(s.if, values)).map((s) => s.name);
    const ranV4 = running(wf, caller).filter((n) =>
      n !== CHECK_STEP && n !== RECORD_STEP
    );
    assertEquals(ranV4, ranV3, JSON.stringify(caller));
  }
  // The added steps for such a caller: the credentials check and the record, unless warm-only.
  assertEquals(
    running(wf, { "app-name": "x" }).filter((n) =>
      n === CHECK_STEP || n === RECORD_STEP
    ),
    [CHECK_STEP, RECORD_STEP],
  );
  assertEquals(
    running(wf, { "app-name": "x", "warm-only": true }).filter((n) =>
      n === CHECK_STEP || n === RECORD_STEP
    ),
    [],
  );
});
