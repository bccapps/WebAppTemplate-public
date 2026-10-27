/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { timestampColumnType } from '../../common/utils/dbEngine';
import type { IssueReportClosedReason, IssueReportStatus } from '../issueReportTypes';

/**
 * A report sent to the Agent Hub by a signed-in user. Only what the app needs to follow it and to tell the reporter:
 * the description itself lives on the hub; the reporter's address is never stored here (read through `USER_CONTACT`
 * when the closure notice is sent).
 */
@Entity({ name: 'issue_report' })
@Index('IDX_issue_report_user_created', ['userId', 'createdAt'])
@Index('IDX_issue_report_status', ['status'])
@Index('IDX_issue_report_hub_number', ['hubNumber'])
export class IssueReportEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Id of the authenticated principal (as text: the module does not depend on the user module's key type). */
  @Column({ name: 'user_id', type: 'varchar', length: 64 })
  userId!: string;

  /** Number of the issue in the hub project (per project, from the hub's `201 { number }`). */
  @Column({ name: 'hub_number', type: 'int' })
  hubNumber!: number;

  /** Copy of the title, so the reporter's list needs no call to the hub. */
  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'varchar', length: 6, default: 'open' })
  status!: IssueReportStatus;

  @Column({ name: 'closed_reason', type: 'varchar', length: 12, nullable: true })
  closedReason!: IssueReportClosedReason | null;

  @Column({ name: 'closed_at', type: timestampColumnType(), nullable: true })
  closedAt!: Date | null;

  /** Set when the closure notice was handled (sent, or no address): the e-mail goes out once. */
  @Column({ name: 'notified_at', type: timestampColumnType(), nullable: true })
  notifiedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: timestampColumnType() })
  createdAt!: Date;
}
