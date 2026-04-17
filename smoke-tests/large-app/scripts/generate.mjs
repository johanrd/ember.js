#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Deterministic generator for smoke-tests/large-app.
 *
 * Reads scripts/seed.json, writes files under app/**\/generated/, emits
 * scripts/last-generation.json as a manifest (sorted, hashed) for
 * determinism verification.
 *
 * The output is syntactically valid but semantically meaningless — routes
 * aren't registered, services reference things that don't exist, etc. Only
 * contract: `vite build` succeeds.
 */
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = dirname(HERE);
const APP_SRC = join(APP_ROOT, 'app');
const SEED_PATH = join(HERE, 'seed.json');
const MANIFEST_PATH = join(HERE, 'last-generation.json');

// ---- PRNG (mulberry32, public-domain) -------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const makeRng = (seed) => mulberry32(seed);
const rndInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
const rndChoice = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// ---- Generators for each bucket -------------------------------------------

function genLeafGjs(idx, rng) {
  const greeting = rndChoice(rng, ['Hi', 'Hello', 'Hey', 'Greetings', 'Welcome']);
  // .gjs is plain JavaScript + <template>; no TS types allowed.
  return `import Component from '@glimmer/component';

export default class Leaf${idx} extends Component {
  get doubled() {
    return (this.args.value ?? 0) * 2;
  }

  get tripled() {
    return (this.args.value ?? 0) * 3;
  }

  <template>
    <div class='leaf-${idx}'>
      <span class='greet'>${greeting}</span>
      <span class='label'>{{@label}}</span>
      <span class='doubled'>{{this.doubled}}</span>
      <span class='tripled'>{{this.tripled}}</span>
    </div>
  </template>
}
`;
}

function genMidGts(idx, rng, sizeTarget) {
  const methods = Math.max(3, Math.floor(sizeTarget / 400));
  const actions = [];
  const trackedFields = [];
  for (let i = 0; i < methods; i++) {
    trackedFields.push(`  @tracked field${i}: string = '${rndChoice(rng, ['alpha', 'beta', 'gamma', 'delta'])}${i}';`);
    actions.push(
      `  @action\n  handle${i}(id: string): void {\n    this.field${i} = id + '-${rndInt(rng, 0, 999)}';\n    this.selected = id;\n  }`
    );
  }
  return `import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { on } from '@ember/modifier';
import { fn } from '@ember/helper';

interface Item { id: string; label: string; kind?: string }
interface Signature {
  Args: {
    items: Item[];
    title?: string;
    onSelect?: (id: string) => void;
  };
}

export default class Mid${idx} extends Component<Signature> {
  @tracked selected: string | null = null;
${trackedFields.join('\n')}

${actions.join('\n\n')}

  @action
  clear(): void {
    this.selected = null;
  }

  <template>
    <section class='mid-${idx}'>
      <header>
        <h3>{{@title}}</h3>
        {{#if this.selected}}
          <button type='button' {{on 'click' this.clear}}>Clear</button>
        {{/if}}
      </header>
      <ul>
        {{#each @items as |item|}}
          <li class='row'>
            <button type='button' {{on 'click' (fn this.handle0 item.id)}}>
              {{item.label}}
              {{#if item.kind}}<span class='badge'>{{item.kind}}</span>{{/if}}
            </button>
          </li>
        {{/each}}
      </ul>
    </section>
  </template>
}
`;
}

function genRoute(idx, rng, sizeTarget) {
  const services = Math.max(2, Math.floor(sizeTarget / 500));
  const decls = [];
  for (let i = 0; i < services; i++) {
    decls.push(`  @service declare svc${i}: unknown;`);
  }
  return `import Route from '@ember/routing/route';
import { service } from '@ember/service';

type Model = { id: number; items: string[]; timestamp: number };

export default class Route${idx} extends Route {
${decls.join('\n')}

  async model(): Promise<Model> {
    return {
      id: ${idx},
      items: [${Array.from({ length: rndInt(rng, 3, 8) }, (_, i) => `'item-${i}'`).join(', ')}],
      timestamp: Date.now(),
    };
  }

  resetController(controller: unknown, isExiting: boolean): void {
    if (isExiting) {
      // no-op stub
    }
  }
}
`;
}

function genController(idx, rng, sizeTarget) {
  const actions = Math.max(4, Math.floor(sizeTarget / 300));
  const trackedFields = [];
  const actionDefs = [];
  for (let i = 0; i < actions; i++) {
    trackedFields.push(`  @tracked field${i}: string | null = null;`);
    actionDefs.push(
      `  @action\n  action${i}(value: string): void {\n    this.field${i} = value + '-${rndInt(rng, 0, 999)}';\n    this.selected = value;\n  }`
    );
  }
  return `import Controller from '@ember/controller';
import { action } from '@ember/object';
import { tracked } from '@glimmer/tracking';
import { service } from '@ember/service';

export default class Controller${idx} extends Controller {
  @service declare session: unknown;
  @service declare router: unknown;

  @tracked filter: string = '';
  @tracked selected: string | null = null;
${trackedFields.join('\n')}

${actionDefs.join('\n\n')}

  @action
  clear(): void {
    this.filter = '';
    this.selected = null;
  }
}
`;
}

function genService(idx, rng, sizeTarget) {
  const methods = Math.max(3, Math.floor(sizeTarget / 300));
  const trackedFields = [];
  const methodDefs = [];
  for (let i = 0; i < methods; i++) {
    trackedFields.push(`  @tracked count${i}: number = 0;`);
    methodDefs.push(`  increment${i}(): void { this.count${i} += ${rndInt(rng, 1, 5)}; }`);
  }
  return `import Service, { service } from '@ember/service';
import { tracked } from '@glimmer/tracking';

export default class Svc${idx} extends Service {
  @service declare other: unknown;
${trackedFields.join('\n')}

${methodDefs.join('\n')}

  reset(): void {
${Array.from({ length: methods }, (_, i) => `    this.count${i} = 0;`).join('\n')}
  }
}
`;
}

// "Route templates" and "admin templates" are implemented as large template-tag
// components (.gjs) rather than classic .hbs. Classic route/controller .hbs
// would need to be paired with a backing class and registered via Router.map
// to be pulled through the build pipeline; that's a classic-resolver signal we
// defer. Big <template> blocks in .gjs still stress the template-compile path
// on large source sizes, which is the signal this bucket is here for.
function genRouteTemplate(idx, rng, sizeTarget) {
  const classHead = `import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { on } from '@ember/modifier';
import { fn } from '@ember/helper';

export default class RouteTemplate${idx} extends Component {
  @tracked filter = '';
  @tracked activeTag = null;

  @action
  setFilter(value) { this.filter = value; }

  @action
  selectTag(tag) { this.activeTag = tag; }

  <template>
    <section class='route-${idx}'>
      <header class='route-${idx}-header'>
        <h1>Route ${idx}</h1>
        {{#if this.filter}}<span class='filter-badge'>{{this.filter}}</span>{{/if}}
      </header>
`;
  const classFoot = `    </section>
  </template>
}
`;

  const block = (n) => `      <div class='group group-${n}'>
        <h2>Group ${n}</h2>
        {{#each @items${n} as |item index|}}
          <article class='item item-${n}' data-id='{{item.id}}'>
            <header>
              <h3>{{item.title}}</h3>
              <span class='meta'>#{{index}} · {{item.kind}}</span>
            </header>
            <p class='body'>{{item.body}}</p>
            {{#if item.tags}}
              <ul class='tags'>
                {{#each item.tags as |tag|}}
                  <li class='{{if tag "tag"}}'>
                    <button type='button' {{on 'click' (fn this.selectTag tag)}}>
                      {{tag}}{{#if item.kind}}<span class='star'>*</span>{{/if}}
                    </button>
                  </li>
                {{/each}}
              </ul>
            {{/if}}
            <footer>
              <time>{{item.createdAt}}</time>
              <button type='button' {{on 'click' (fn this.setFilter item.id)}}>Open</button>
            </footer>
          </article>
        {{else}}
          <p class='empty'>No items in group ${n}.</p>
        {{/each}}
      </div>
`;

  let out = classHead;
  let n = 0;
  while (out.length + classFoot.length < sizeTarget) {
    out += block(n);
    n++;
    if (n > 500) break; // safety
  }
  out += classFoot;
  return out;
}

function genAdminTemplate(idx, rng, sizeTarget) {
  const classHead = `import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { on } from '@ember/modifier';
import { fn } from '@ember/helper';

export default class AdminTemplate${idx} extends Component {
  @tracked isInvalid = false;

  @action
  submit(ev) { ev.preventDefault(); }

  @action
  update(id, ev) { /* stub */ }

  @action
  validate(id, ev) { /* stub */ }

  <template>
    <form class='admin-form-${idx}' {{on 'submit' this.submit}}>
      <fieldset>
        <legend>Admin Form ${idx}</legend>
`;
  const classFoot = `      </fieldset>
      <button type='submit' disabled={{this.isInvalid}}>Save</button>
    </form>
  </template>
}
`;

  const field = (n) => `        <div class='field field-${n}'>
          <label for='field-${n}'>Field ${n}</label>
          <input
            id='field-${n}'
            name='field-${n}'
            type='text'
            value={{@value${n}}}
            placeholder='Enter value ${n}'
            {{on 'input' (fn this.update '${n}')}}
            {{on 'blur' (fn this.validate '${n}')}}
          />
          {{#if @error${n}}}
            <span class='error'>{{@error${n}}}</span>
          {{else if @warning${n}}}
            <span class='warning'>{{@warning${n}}}</span>
          {{/if}}
          {{#if @focus${n}}}
            <span class='hint'>Hint for field ${n}: {{@hint${n}}}</span>
          {{/if}}
        </div>
`;

  let out = classHead;
  let n = 0;
  while (out.length + classFoot.length < sizeTarget) {
    out += field(n);
    n++;
    if (n > 1000) break; // safety
  }
  out += classFoot;
  return out;
}

function genHelper(idx, rng) {
  return `import { helper } from '@ember/component/helper';

export default helper(function helper${idx}(
  positional: [unknown, ...unknown[]],
  named: Record<string, unknown>
): string {
  const [head, ...rest] = positional;
  return [String(head ?? ''), ...rest.map((v) => String(v))].join('${rndChoice(rng, ['-', '/', ' · ', ' '])}');
});
`;
}

function genModifier(idx, rng) {
  // Not using ember-modifier (no dep); a decorator-bearing class lets the
  // babel pipeline still process decorator-transforms for this file.
  return `import { tracked } from '@glimmer/tracking';
import { service } from '@ember/service';

export default class Modifier${idx} {
  @service declare session: unknown;
  @tracked active: boolean = false;

  apply(node: Element, args: { value?: string }): void {
    node.setAttribute('data-mod-${idx}', args.value ?? '${rndChoice(rng, ['on', 'off', 'pending'])}');
    this.active = true;
  }

  cleanup(node: Element): void {
    node.removeAttribute('data-mod-${idx}');
    this.active = false;
  }
}
`;
}

function genUtil(idx, rng, sizeTarget) {
  const fns = Math.max(2, Math.floor(sizeTarget / 120));
  const out = [`export const UTIL_ID_${idx} = ${idx};\n`];
  for (let i = 0; i < fns; i++) {
    const op = rndChoice(rng, ['+', '-', '*']);
    out.push(`export function compute_${idx}_${i}(a, b) {\n  return a ${op} b + ${rndInt(rng, 0, 100)};\n}\n`);
  }
  return out.join('\n');
}

// ---- Driver ---------------------------------------------------------------

const BUCKETS = {
  leafComponent:  { dir: 'components/generated/leaf',  ext: '.gjs', gen: genLeafGjs },
  midComponent:   { dir: 'components/generated/mid',   ext: '.gts', gen: genMidGts },
  route:          { dir: 'routes/generated',           ext: '.ts',  gen: genRoute },
  controller:     { dir: 'controllers/generated',      ext: '.ts',  gen: genController },
  routeTemplate:  { dir: 'components/generated/route-templates', ext: '.gjs', gen: genRouteTemplate },
  adminTemplate:  { dir: 'components/generated/admin-templates', ext: '.gjs', gen: genAdminTemplate },
  service:        { dir: 'services/generated',         ext: '.ts',  gen: genService },
  helper:         { dir: 'helpers/generated',          ext: '.ts',  gen: genHelper },
  modifier:       { dir: 'modifiers/generated',        ext: '.ts',  gen: genModifier },
  util:           { dir: 'utils/generated',            ext: '.js',  gen: genUtil },
};

async function main() {
  const t0 = Date.now();
  const { readFile } = await import('node:fs/promises');
  const seed = JSON.parse(await readFile(SEED_PATH, 'utf8'));

  // Clean out previous generation. All generated paths live under app/**/generated/;
  // we nuke each bucket's dir before re-writing to avoid stale files.
  for (const { dir } of Object.values(BUCKETS)) {
    await rm(join(APP_SRC, dir), { recursive: true, force: true });
  }

  // Sub-seed each bucket so adjusting one bucket doesn't cascade-shift all others.
  // Each bucket gets rngSeed + bucketIndex.
  const bucketEntries = Object.entries(seed.buckets);
  const manifest = { seedVersion: seed.version, rngSeed: seed.rngSeed, files: [] };

  let totalBytes = 0;
  for (const [bucketKey, bucketCfg] of bucketEntries) {
    const def = BUCKETS[bucketKey];
    if (!def) {
      console.error(`seed.json references unknown bucket: ${bucketKey}`);
      process.exit(2);
    }
    const bucketIndex = Object.keys(BUCKETS).indexOf(bucketKey);
    const rng = makeRng(seed.rngSeed + bucketIndex);
    const [minSize, maxSize] = bucketCfg.sizeChars;
    const absDir = join(APP_SRC, def.dir);
    await mkdir(absDir, { recursive: true });

    for (let i = 0; i < bucketCfg.count; i++) {
      const targetSize = rndInt(rng, minSize, maxSize);
      const content = def.gen(i, rng, targetSize);
      const relPath = join('app', def.dir, `${bucketKey}-${i}${def.ext}`);
      const absPath = join(APP_ROOT, relPath);
      await writeFile(absPath, content, 'utf8');
      totalBytes += Buffer.byteLength(content);
      const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
      manifest.files.push({ path: relPath, bytes: Buffer.byteLength(content), hash });
    }
  }

  manifest.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  manifest.totalFiles = manifest.files.length;
  manifest.totalBytes = totalBytes;
  // Determinism digest: hash of the manifest content excluding this field.
  // Two runs on the same seed.json + generator commit must produce the same
  // value here; if they diverge, determinism is broken.
  const digestable = JSON.stringify({
    seedVersion: manifest.seedVersion,
    rngSeed: manifest.rngSeed,
    files: manifest.files,
  });
  manifest.determinismDigest = createHash('sha256').update(digestable).digest('hex');
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const ms = Date.now() - t0;
  const mb = (totalBytes / 1024 / 1024).toFixed(2);
  console.log(`[generate] ${manifest.totalFiles} files, ${mb} MB, ${ms}ms`);
  console.log(`[generate] manifest: ${MANIFEST_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
