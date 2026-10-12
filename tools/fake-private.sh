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
# (nest + react) that imports `common`. Used by CI sandboxes.
# Usage: tools/fake-private.sh <dir>
set -euo pipefail
DIR="${1:?usage: fake-private.sh <dir>}"
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
