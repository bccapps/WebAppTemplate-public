#!/usr/bin/env bash
# =============================================================================
# VXFramework
#
# Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
# SPDX-License-Identifier: MIT
#
# Licensed under the MIT License. See LICENSE in the project root.
# =============================================================================
# Writes a tiny stand-in for WebAppTemplate-private into <dir>: one module `fakemod`
# (nest + react) that imports `common`. With --users it also writes minimal stand-ins of
# `user`, `commerce`, `infra` and `tenant` (they compile against `common`, and carry the same
# module.json questions as the real ones, reduced), and two plugin fixtures: `fakemulti` (a plugin with `module` +
# several `modules` and an `order`) and `fakefactory` (a plugin whose `module` is a factory fed by
# `back/src/config/pluginOptions.ts`). Used by CI sandboxes.
# Usage: tools/fake-private.sh <dir> [--users]
set -euo pipefail
DIR="${1:?usage: fake-private.sh <dir> [--users]}"
WITH_USERS="${2:-}"
mkdir -p "${DIR}/nest/fakemod/entities" "${DIR}/react/fakemod"
cat > "${DIR}/nest/fakemod/FakeModule.ts" <<'TS'
import { Module } from '@nestjs/common';
import ResponseDto from '../common/dtos/ResponseDto';
export const fakeResponse = (): ResponseDto => new ResponseDto();
@Module({})
export class FakeModule {}
TS
cat > "${DIR}/nest/fakemod/entities/FakeEntity.ts" <<'TS'
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
@Entity('fake_entity')
export class FakeEntity {
  @PrimaryGeneratedColumn()
  id!: number;
  @Column({ type: 'text', default: '' })
  label!: string;
}
TS
cat > "${DIR}/react/fakemod/fake.ts" <<'TS'
import { i18n } from '../common/core/i18n/I18n';
export const fakeLabel = (): string => i18n.get('fake');
TS
cat > "${DIR}/nest/fakemod/module.json" <<'JSON'
{
  "id": "fakemod",
  "title": "Fake module",
  "description": "CI stand-in for a private module.",
  "visibility": "private",
  "category": "other",
  "requires": ["common"],
  "env": [],
  "questions": []
}
JSON
cat > "${DIR}/react/fakemod/module.json" <<'JSON'
{
  "id": "fakemod",
  "title": "Fake module",
  "description": "CI stand-in for a private module.",
  "visibility": "private",
  "category": "other",
  "requires": ["common"],
  "env": [],
  "questions": []
}
JSON

if [[ "${WITH_USERS}" == "--users" ]]; then
  write_stub() {   # <stack> <id> <ClassName> <title> <category> <requires-json> <questions-json>
    local stack="$1" id="$2" cls="$3" title="$4" cat="$5" req="$6" questions="$7"
    mkdir -p "${DIR}/${stack}/${id}"
    if [[ "${stack}" == "nest" ]]; then
      cat > "${DIR}/nest/${id}/${cls}.ts" <<TS
import { Module } from '@nestjs/common';
import ResponseDto from '../common/dtos/ResponseDto';
export const ${id//-/_}Marker = (): ResponseDto => new ResponseDto();
@Module({})
export class ${cls} {}
TS
    else
      cat > "${DIR}/react/${id}/${id}.ts" <<TS
import { i18n } from '../common/core/i18n/I18n';
export const ${id//-/_}Label = (): string => i18n.get('${id}');
TS
    fi
    cat > "${DIR}/${stack}/${id}/module.json" <<JSON
{
  "id": "${id}",
  "title": "${title}",
  "description": "CI stand-in for the ${title} module.",
  "visibility": "private",
  "category": "${cat}",
  "requires": ${req},
  "env": [],
  "questions": ${questions}
}
JSON
  }
  USER_Q='[
    { "id": "authMethods", "prompt": "Login methods", "type": "multiselect", "default": ["wallet", "email"],
      "options": [{ "value": "wallet" }, { "value": "email" }, { "value": "social" }, { "value": "openfort" }],
      "effects": [
        { "config": { "name": "user_authMethods", "value": "$answer", "exclude": ["openfort"] } },
        { "when": { "includes": "email" }, "config": { "name": "user_authEmailEnabled", "value": true } },
        { "when": { "excludes": "email" }, "config": { "name": "user_authEmailEnabled", "value": false } } ] },
    { "id": "reownProjectId", "prompt": "Reown project id", "type": "text", "default": "", "when": { "question": "authMethods", "includes": "wallet" },
      "effects": [{ "env": { "stack": "front", "name": "VITE_REOWN_PROJECT_ID", "value": "$answer" } }] },
    { "id": "registration", "prompt": "Sign-up", "type": "select", "default": "open",
      "options": [{ "value": "open" }, { "value": "invitation" }, { "value": "waitlist" }],
      "effects": [
        { "when": { "equals": "invitation" }, "config": { "name": "user_registrationMode", "value": "invite-only" } },
        { "when": { "equals": "waitlist" }, "config": { "name": "user_registrationMode", "value": "manual" } } ] },
    { "id": "multiTenant", "prompt": "Several organizations?", "type": "confirm", "default": false,
      "effects": [{ "when": { "equals": true }, "modules": ["tenant"] }] }
  ]'
  COMMERCE_Q='[
    { "id": "commerce", "prompt": "Selling?", "type": "confirm", "default": false, "alwaysAsk": true, "requiresPrivate": true, "requires": ["user"],
      "effects": [
        { "when": { "equals": true }, "modules": ["commerce"], "configJson": { "name": "features", "path": "commerce.enabled", "value": true } },
        { "when": { "equals": false }, "configJson": { "name": "features", "path": "commerce.enabled", "value": false } } ] }
  ]'
  INFRA_Q='[
    { "id": "infra", "prompt": "Monitoring/health/Redis cache (infra)?", "type": "confirm", "default": false, "defaultMultiUser": true, "alwaysAsk": true, "requiresPrivate": true,
      "effects": [{ "when": { "equals": true }, "modules": ["infra"] }] }
  ]'
  write_stub nest user UserModule User users '["common"]' "${USER_Q}"
  write_stub react user UserModule User users '["common"]' '[]'
  write_stub nest commerce CommerceModule Commerce business '["common", "user"]' "${COMMERCE_Q}"
  write_stub react commerce CommerceModule Commerce business '["user"]' '[]'
  write_stub nest infra InfraModule Infrastructure core '["common"]' "${INFRA_Q}"
  write_stub react infra InfraModule Infrastructure core '["common"]' '[]'
  write_stub nest tenant TenantModule Tenant users '["user"]' '[]'
  # Plugin fixtures (nest only): `fakemulti` registers 3 modules, early; `fakefactory` needs options.
  mkdir -p "${DIR}/nest/fakemulti" "${DIR}/nest/fakefactory"
  cat > "${DIR}/nest/fakemulti/FakeMultiModule.ts" <<'TS'
import { Module } from '@nestjs/common';
@Module({})
export class FakeMultiAModule {}
@Module({})
export class FakeMultiBModule {}
@Module({})
export class FakeMultiCModule {}
TS
  cat > "${DIR}/nest/fakemulti/plugin.ts" <<'TS'
import type { NestModulePlugin } from '../common/plugins/NestModulePlugin';
import { FakeMultiAModule, FakeMultiBModule, FakeMultiCModule } from './FakeMultiModule';
export const plugin: NestModulePlugin = {
  id: 'fakemulti',
  order: 10,
  module: FakeMultiAModule,
  modules: [FakeMultiBModule, FakeMultiCModule],
};
TS
  cat > "${DIR}/nest/fakefactory/FakeFactoryModule.ts" <<'TS'
import { DynamicModule, Module } from '@nestjs/common';
export interface FakeFactoryOptions {
  label: string;
}
export const FAKE_FACTORY_LABEL = 'FAKE_FACTORY_LABEL';
@Module({})
export class FakeFactoryModule {
  static forRoot(options: FakeFactoryOptions): DynamicModule {
    return { module: FakeFactoryModule, providers: [{ provide: FAKE_FACTORY_LABEL, useValue: options.label }] };
  }
}
TS
  cat > "${DIR}/nest/fakefactory/plugin.ts" <<'TS'
import type { NestModulePlugin } from '../common/plugins/NestModulePlugin';
import { requirePluginOptions } from '../common/plugins/resolvePlugins';
import { FakeFactoryModule, type FakeFactoryOptions } from './FakeFactoryModule';
export const plugin: NestModulePlugin<FakeFactoryOptions> = {
  id: 'fakefactory',
  module: (options) => FakeFactoryModule.forRoot(requirePluginOptions('fakefactory', options, ['label'])),
};
TS
  for id in fakemulti fakefactory; do
    cat > "${DIR}/nest/${id}/module.json" <<JSON
{
  "id": "${id}",
  "title": "${id}",
  "description": "CI plugin fixture.",
  "visibility": "private",
  "category": "other",
  "requires": ["common"],
  "env": [],
  "questions": []
}
JSON
  done
fi
