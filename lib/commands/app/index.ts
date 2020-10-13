/**
 * @license
 * Copyright 2016-2020 Balena Ltd.
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

import { flags } from '@oclif/command';
import Command from '../../command';
import * as cf from '../../utils/common-flags';
import { getBalenaSdk, getVisuals, stripIndent } from '../../utils/lazy';
import { tryAsInteger } from '../../utils/validation';
import { Release } from 'balena-sdk';

interface FlagsDef {
	help: void;
}

interface ArgsDef {
	name: string;
}

export default class AppCmd extends Command {
	public static description = stripIndent`
		Display information about a single application.

		Display detailed information about a single balena application.
`;
	public static examples = ['$ balena app MyApp'];

	public static args = [
		{
			name: 'name',
			description: 'application name or numeric ID',
			required: true,
		},
	];

	public static flags: flags.Input<FlagsDef> = {
		help: cf.help,
	};

	public static authenticated = true;
	public static primary = true;

	public async run() {
		const { args: params } = this.parse<FlagsDef, ArgsDef>(AppCmd);

		const application = (await getBalenaSdk().models.application.get(
			tryAsInteger(params.name),
			{
				$expand: {
					is_for__device_type: { $select: 'slug' },
					should_be_running__release: { $select: 'commit' },
				},
			},
		)) as ApplicationWithDeviceType & {
			should_be_running__release: [Release?];
		};

		// @ts-expect-error
		application.device_type = application.is_for__device_type[0].slug;
		// @ts-expect-error
		application.commit = application.should_be_running__release[0]?.commit;
		console.log(
			getVisuals().table.vertical(application, [
				`$${application.app_name}$`,
				'id',
				'device_type',
				'slug',
				'commit',
			]),
		);
	}
}
