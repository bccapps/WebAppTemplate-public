/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// This file should exist in `src/common/helpers`
import fs from 'fs';
import { promisify } from 'util';

class FileHelper {
  /**
   * Check if a file exists at a given path.
   *
   * @param {string} path
   *
   * @returns {boolean}
   */
  exists = (path: string): boolean => {
    return fs.existsSync(path);
  };

  /**
   * Gets file data from a given path via a promise interface.
   *
   * @param {string} path
   * @param {string} encoding
   *
   * @returns {Promise<Buffer>}
   */
  get = async (
    path: string,
    encoding: BufferEncoding
  ): Promise<string | Buffer> => {
    const readFile = promisify(fs.readFile);

    return encoding ? readFile(path, { encoding: encoding }) : readFile(path, {});
  };

  /**
   * Writes a file at a given path via a promise interface.
   *
   * @param {string} path
   * @param {string} fileName
   * @param {string} data
   *
   * @return {Promise<void>}
   */
  create = async (
    path: string,
    fileName: string,
    data: string
  ): Promise<void> => {
    if (!this.exists(path)) {
      fs.mkdirSync(path);
    }

    const writeFile = promisify(fs.writeFile);

    return await writeFile(`${path}/${fileName}`, data, 'utf8');
  };

  /**
   * Delete file at the given path via a promise interface
   *
   * @param {string} path
   *
   * @returns {Promise<void>}
   */
  delete = async (path: string): Promise<void> => {
    const unlink = promisify(fs.unlink);

    return await unlink(path);
  };
}

export const fileHelper = new FileHelper();