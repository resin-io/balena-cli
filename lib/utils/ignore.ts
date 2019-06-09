/**
 * @license
 * Copyright 2019 Balena Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as _ from 'lodash';
import { fs } from 'mz';
import * as path from 'path';
import * as MultiBuild from 'resin-multibuild';

import dockerIgnore = require('@zeit/dockerignore');
import ignore from 'ignore';

const { toPosixPath } = MultiBuild.PathUtils;

export enum IgnoreFileType {
	DockerIgnore,
	GitIgnore,
}

interface IgnoreEntry {
	pattern: string;
	// The relative file path from the base path of the build context
	filePath: string;
}

export class FileIgnorer {
	private dockerIgnoreEntries: IgnoreEntry[];
	private gitIgnoreEntries: IgnoreEntry[];

	private static ignoreFiles: Array<{
		pattern: string;
		type: IgnoreFileType;
		allowSubdirs: boolean;
	}> = [
		{
			pattern: '.gitignore',
			type: IgnoreFileType.GitIgnore,
			allowSubdirs: true,
		},
		{
			pattern: '.dockerignore',
			type: IgnoreFileType.DockerIgnore,
			allowSubdirs: false,
		},
	];

	public constructor(public basePath: string) {
		this.dockerIgnoreEntries = [];
		this.gitIgnoreEntries = [];
	}
	/**
	 * @param  {string} relativePath
	 * 	The relative pathname from the build context, for example a root level .gitignore should be
	 * 		./.gitignore
	 * @returns IgnoreFileType
	 * 	The type of ignore file, or null
	 */
	public getIgnoreFileType(relativePath: string): IgnoreFileType | null {
		for (const { pattern, type, allowSubdirs } of FileIgnorer.ignoreFiles) {
			if (
				path.basename(relativePath) === pattern &&
				(allowSubdirs || path.dirname(relativePath) === '.')
			) {
				return type;
			}
		}

		return null;
	}
	/**
	 * @param  {string} fullPath
	 * 	The full path on disk of the ignore file
	 * @param  {IgnoreFileType} type
	 * @returns Promise
	 */
	public async addIgnoreFile(
		fullPath: string,
		type: IgnoreFileType,
	): Promise<void> {
		const contents = await fs.readFile(fullPath, 'utf8');

		contents.split('\n').forEach(line => {
			// ignore empty lines and comments
			if (/\s*#/.test(line) || _.isEmpty(line)) {
				return;
			}

			this.addEntry(line, fullPath, type);
		});

		return;
	}

	// Pass this function as a predicate to a filter function, and it will filter
	// any ignored files
	public filter = (filename: string): boolean => {
		let relFile = path.relative(this.basePath, filename);

		// Don't ignore any metadata files
		// The regex below matches `.balena/qemu` and `myservice/.balena/qemu`
		// but not `some.dir.for.balena/qemu`.
		if (/(^|\/)\.(balena|resin)\//.test(toPosixPath(relFile))) {
			return true;
		}

		const dockerIgnoreHandle = dockerIgnore();
		const gitIgnoreHandle = ignore();

		interface IgnoreHandle {
			add: (pattern: string) => void;
			ignores: (file: string) => boolean;
		}

		const ignoreTypes: Array<{
			handle: IgnoreHandle;
			entries: IgnoreEntry[];
		}> = [
			{ handle: dockerIgnoreHandle, entries: this.dockerIgnoreEntries },
			{ handle: gitIgnoreHandle, entries: this.gitIgnoreEntries },
		];

		_.each(ignoreTypes, ({ handle, entries }) => {
			_.each(entries, ({ pattern, filePath }) => {
				if (FileIgnorer.contains(path.posix.dirname(filePath), filename)) {
					relFile = path.relative(path.posix.dirname(filePath), filename);
					handle.add(pattern);
				}
			});
		});

		return !_.some(ignoreTypes, ({ handle }) => handle.ignores(relFile));
	}; // tslint:disable-line:semicolon

	private addEntry(
		pattern: string,
		filePath: string,
		type: IgnoreFileType,
	): void {
		const entry: IgnoreEntry = { pattern, filePath };
		switch (type) {
			case IgnoreFileType.DockerIgnore:
				this.dockerIgnoreEntries.push(entry);
				break;
			case IgnoreFileType.GitIgnore:
				this.gitIgnoreEntries.push(entry);
				break;
		}
	}

	/**
	 * Given two paths, check whether the first contains the second
	 * @param path1 The potentially containing path
	 * @param path2 The potentially contained path
	 * @return A boolean indicating whether `path1` contains `path2`
	 */
	private static contains(path1: string, path2: string): boolean {
		// First normalise the input, to remove any path weirdness
		path1 = path.posix.normalize(path1);
		path2 = path.posix.normalize(path2);

		// Now test if the start of the relative path contains ../ ,
		// which would tell us that path1 is not part of path2
		return !/^\.\.\//.test(path.posix.relative(path1, path2));
	}
}
