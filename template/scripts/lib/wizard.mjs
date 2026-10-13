/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Prompt helpers shared by create-project.mjs and add-module.mjs (node:readline, no dependency). */

import readline from 'node:readline/promises';

import { BASE_MODULES, applicableQuestions, questionDefault, resolveProject } from './project-engine.mjs';

export const csv = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);

export class Prompter {
  constructor(interactive) {
    this.interactive = interactive;
    this.closed = false;
    if (interactive) {
      this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      this.rl.on('close', () => { this.closed = true; });
    }
  }

  async text(prompt, def = '') {
    if (!this.interactive || this.closed) return def;
    const suffix = def !== '' ? ` [${def}]` : '';
    try {
      const answer = (await this.rl.question(`${prompt}${suffix}: `)).trim();
      return answer === '' ? def : answer;
    } catch {
      return def;
    }
  }

  async confirm(prompt, def = false) {
    const answer = await this.text(`${prompt} (y/n)`, def ? 'y' : 'n');
    return /^(y|yes|o|oui|true|1)$/i.test(answer);
  }

  async select(prompt, options, def) {
    const labels = options.map((o, i) => `${i + 1}) ${o.label ?? o.value ?? o}`);
    if (this.interactive && !this.closed) console.log(`${prompt}\n  ${labels.join('\n  ')}`);
    const defValue = def ?? options[0].value ?? options[0];
    const answer = await this.text('Choice (number or value)', String(defValue));
    const byIndex = options[Number(answer) - 1];
    if (byIndex) return byIndex.value ?? byIndex;
    return options.find((o) => (o.value ?? o) === answer) ? answer : defValue;
  }

  async multiselect(prompt, options, def = []) {
    const labels = options.map((o, i) => `${i + 1}) ${o.value ?? o}${o.label ? ` — ${o.label}` : ''}`);
    if (this.interactive && !this.closed) console.log(`${prompt}\n  ${labels.join('\n  ')}`);
    const answer = await this.text('Choices (numbers or values, comma-separated, "-" = none)', def.join(','));
    if (answer === '-') return [];
    const values = options.map((o) => o.value ?? o);
    return csv(answer).map((tok) => values[Number(tok) - 1] ?? tok).filter((v) => values.includes(v));
  }

  close() { this.rl?.close(); }
}

async function askQuestion(prompter, q, answers) {
  const def = questionDefault(q, answers);
  switch (q.type) {
    case 'confirm': return prompter.confirm(q.prompt, def);
    case 'select': return prompter.select(q.prompt, q.options, def);
    case 'multiselect': return prompter.multiselect(q.prompt, q.options, def);
    default: return prompter.text(q.prompt, def);
  }
}

/** Ask module questions until the set of applicable questions is stable. */
export async function askModuleQuestions(prompter, catalog, answers) {
  const asked = new Set(Object.keys(answers.questions));
  for (let pass = 0; pass < 6; pass++) {
    const resolved = resolveProject(catalog, answers);
    const pending = applicableQuestions(catalog, answers, resolved.ids).filter((q) => !asked.has(q.id));
    if (!pending.length) return;
    const q = pending[0];
    asked.add(q.id);
    let value = await askQuestion(prompter, q, answers);
    if (value && q.requires?.some((need) => !resolved.ids.includes(need))) {
      if (await prompter.confirm(`"${q.id}" needs user accounts. Enable multi-user accounts now?`, true)) {
        answers.multiUser = true;
        asked.delete(q.id);
        continue;
      }
      value = false;
    }
    answers.questions[q.id] = value;
  }
}

export async function selectFunctionalModules(prompter, catalog, answers) {
  const hidden = new Set([...BASE_MODULES, 'user']);
  const candidates = [...catalog.byId.values()]
    .filter((m) => !hidden.has(m.id) && (answers.privateAccess || m.visibility === 'public'))
    .sort((x, y) => x.category.localeCompare(y.category) || x.id.localeCompare(y.id));
  if (!candidates.length) return [];
  const options = candidates.map((m) => ({ value: m.id, label: `[${m.category}] ${m.description}` }));
  return prompter.multiselect('Functional modules', options, answers.modules ?? []);
}

