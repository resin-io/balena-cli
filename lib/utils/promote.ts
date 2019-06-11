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
import * as BalenaSdk from 'balena-sdk';
import { stripIndent } from 'common-tags';

import { runCommand } from './helpers';
import Logger = require('./logger');
import { exec, execBuffered } from './ssh';

const MIN_BALENAOS_VERSION = 'v2.14.0';

export async function join(
	logger: Logger,
	sdk: BalenaSdk.BalenaSDK,
	deviceHostnameOrIp?: string,
	appName?: string,
): Promise<void> {
	logger.logDebug('Checking login...');
	const isLoggedIn = await sdk.auth.isLoggedIn();
	if (!isLoggedIn) {
		logger.logInfo("Looks like you're not logged in yet!");
		logger.logInfo("Let's go through a quick wizard to get you started.\n");
		await runCommand('login');
	}

	logger.logDebug('Determining device...');
	const deviceIp = await getOrSelectLocalDevice(deviceHostnameOrIp);
	await assertDeviceIsCompatible(deviceIp);
	logger.logDebug(`Using device: ${deviceIp}`);

	logger.logDebug('Determining device type...');
	const deviceType = await getDeviceType(deviceIp);
	logger.logDebug(`Device type: ${deviceType}`);

	logger.logDebug('Determining application...');
	const app = await getOrSelectApplication(sdk, deviceType, appName);
	logger.logDebug(`Using application: ${app.app_name} (${app.device_type})`);
	if (app.device_type !== deviceType) {
		logger.logDebug(`Forcing device type to: ${deviceType}`);
		app.device_type = deviceType;
	}

	logger.logDebug('Determining device OS version...');
	const deviceOsVersion = await getOsVersion(deviceIp);
	logger.logDebug(`Device OS version: ${deviceOsVersion}`);

	logger.logDebug('Generating application config...');
	const config = await generateApplicationConfig(sdk, app, {
		version: deviceOsVersion,
	});

	logger.logDebug('Configuring...');
	const vpnConfig = await getOpenVpnConfig(sdk);

	const device = await getConfiguredDevice(deviceIp)
		.catch(e => {
			logger.logError(e);
			return { uuid: '' };
		})
		.then(({ uuid }) => {
			if (uuid != '') {
				logger.logDebug(`Attempting to use existing UUID: ${uuid}`);
				return sdk.models.device
					.generateDeviceKey(uuid)
					.then(k => {
						logger.logDebug('Device key generated!');
						return sdk.models.device.get(uuid, { $select: 'id' }).then(d => {
							return {
								uuid,
								id: d.id,
								api_key: k,
							};
						});
					})
					.catch(e => {
						logger.logError(e);
						// register this UUID to the app...
						return sdk.models.device.register(app.id, uuid);
					})
					.catch(e => {
						logger.logError(e);
						// register with a blank UUID to get a new one...
						return sdk.models.device.register(app.id, '');
					})
					.then(d => {
						return {
							id: d.id,
							uuid: d.uuid,
							apiKey: d.api_key,
						};
					});
			} else {
				logger.logDebug('Existing UUID not found, registering a new one...');
				return sdk.models.device.register(app.id, '').then(d => {
					return { id: d.id, uuid: d.uuid, apiKey: d.api_key };
				});
			}
		});
	logger.logDebug(`Device UUID: ${device.uuid}`);

	const deviceConfig = config as any;
	deviceConfig.uuid = device.uuid;
	deviceConfig.deviceApiKey = device.apiKey;
	deviceConfig.registered_at = Math.floor(Date.now() / 1000);
	deviceConfig.deviceId = device.id;
	delete deviceConfig['apiKey'];

	logger.logDebug(`Using config: ${JSON.stringify(deviceConfig, null, 2)}`);

	await preflight(deviceIp, config, vpnConfig).then(() =>
		configure(deviceIp, deviceConfig),
	);
	logger.logDebug('All done.');

	const platformUrl = await sdk.settings.get('balenaUrl');
	logger.logSuccess(`Device successfully joined ${platformUrl}!`);
}

export async function leave(
	logger: Logger,
	_sdk: BalenaSdk.BalenaSDK,
	deviceHostnameOrIp?: string,
): Promise<void> {
	logger.logDebug('Determining device...');
	const deviceIp = await getOrSelectLocalDevice(deviceHostnameOrIp);
	await assertDeviceIsCompatible(deviceIp);
	logger.logDebug(`Using device: ${deviceIp}`);

	logger.logDebug('Deconfiguring...');
	await deconfigure(deviceIp);
	logger.logDebug('All done.');

	logger.logSuccess('Device successfully left the platform.');
}

async function execCommand(
	deviceIp: string,
	cmd: string,
	msg: string,
): Promise<void> {
	const through = await import('through2');
	const visuals = await import('resin-cli-visuals');

	const spinner = new visuals.Spinner(`[${deviceIp}] Connecting...`);
	const innerSpinner = spinner.spinner;

	const stream = through(function(data, _enc, cb) {
		innerSpinner.setSpinnerTitle(`%s [${deviceIp}] ${msg}`);
		cb(null, data);
	});

	spinner.start();
	await exec(deviceIp, cmd, stream).catch(e => {
		spinner.stop();
		throw e;
	});
	spinner.stop();
}

async function preflight(
	deviceIp: string,
	config: any,
	vpnConfig: { config: string; ca: string },
) {
	config = config as {
		apiEndpoint: string;
		apiKey: string;
		balenaRootCA: string;
	};

	const tmpDir = '/tmp/balena-join';
	return await execCommand(
		deviceIp,
		`'mkdir -p ${tmpDir}'`,
		'Setting up temp dir...',
	)
		.then(() =>
			execCommand(
				deviceIp,
				`'echo "$(base64 -d <<< ${
					config.balenaRootCA
				})" > ${tmpDir}/balenaRootCA-api.pem'`,
				'Copying root CA certificate...',
			),
		)
		.then(() =>
			execCommand(
				deviceIp,
				`'curl --head --output /dev/null --silent --cacert ${tmpDir}/balenaRootCA-api.pem ${
					config.apiEndpoint
				}/ping'`,
				'Checking API is accessible...',
			),
		)
		.then(() => {
			const b = Buffer.from(vpnConfig.ca);

			return execCommand(
				deviceIp,
				`'echo "$(base64 -d <<< ${b.toString(
					'base64',
				)})" > ${tmpDir}/openvpn-ca.crt'`,
				'Copying VPN root CA certificate...',
			);
		})
		.then(() =>
			execCommand(
				deviceIp,
				`'echo "${config.uuid}\r\n${
					config.apiKey
				}\r\n" > ${tmpDir}/openvpn-auth'`,
				'Copying VPN credentials...',
			),
		)
		.then(() => {
			const b = Buffer.from(
				[
					vpnConfig.config
						.replace('/var/volatile/vpn-auth', `${tmpDir}/openvpn-auth`)
						.replace('/etc/openvpn/ca.crt', `${tmpDir}/openvpn-ca.crt`)
						.replace('dev resin-vpn', 'dev resin-vpn-tmp'),
				].join('\r\n'),
			);

			return execCommand(
				deviceIp,
				`'echo "$(base64 -d <<< ${b.toString(
					'base64',
				)})" > ${tmpDir}/openvpn.conf'`,
				'Copying VPN configuration...',
			);
		})
		.then(() =>
			execCommand(
				deviceIp,
				`'nohup openvpn --config ${tmpDir}/openvpn.conf --writepid ${tmpDir}/openvpn.pid >${tmpDir}/openvpn.log 2>&1 |tee &'`,
				'Running OpenVPN...',
			),
		)
		.then(() =>
			execCommand(
				deviceIp,
				`'[[ "$(route | grep resin-vpn | awk \'{ print $1 }\')" != "" ]])'`,
				'Testing OpenVPN...',
			),
		)
		.catch(() => {})
		.then(() =>
			execCommand(
				deviceIp,
				`'kill -15 $(cat ${tmpDir}/openvpn.pid) || true'`,
				'Stopping OpenVPN...',
			).then(() => execCommand(deviceIp, `rm -rf ${tmpDir}`, 'Cleaning up...')),
		);
}

async function getOpenVpnConfig(balena: BalenaSdk.BalenaSDK) {
	const settings = await balena.settings.getAll();

	return await balena.request
		.send({
			baseUrl: settings.apiUrl,
			url: '/os/v1/config',
		})
		.then(res => {
			const config = res.body as {
				services: { openvpn: { config: string; ca: string } };
			};

			return {
				config: config.services.openvpn.config,
				ca: config.services.openvpn.ca,
			};
		});
}

async function configure(deviceIp: string, config: any): Promise<void> {
	// Passing the JSON is slightly tricky due to the many layers of indirection
	// so we just base64-encode it here and decode it at the other end, when invoking
	// os-config.
	const json = JSON.stringify(config);
	const b64 = Buffer.from(json).toString('base64');
	const str = `"$(base64 -d <<< ${b64})"`;
	await execCommand(
		deviceIp,
		`'nohup os-config join ${str} >/var/log/os-config 2>&1 |tee &'`,
		'Configuring...',
	);
}

async function getConfiguredDevice(deviceIp: string) {
	// Passing the JSON is slightly tricky due to the many layers of indirection
	// so we just base64-encode it here and decode it at the other end, when invoking
	// os-config.
	const configJson = await execBuffered(
		deviceIp,
		'\'cat /mnt/boot/config.json || echo "{}"\'',
	);

	const config = JSON.parse(configJson) as { uuid?: string; apiKey?: string };

	if (config.uuid == undefined) {
		throw new Error('Existing UUID is not defined.');
	}

	if (!(config.uuid.length === 32 || config.uuid.length === 62)) {
		throw new Error(
			`Existing UUID is not either 32 or 62 chars in length: ${config.uuid} (${
				config.uuid.length
			}).`,
		);
	}

	return config;
}

async function deconfigure(deviceIp: string): Promise<void> {
	await execCommand(deviceIp, 'os-config leave', 'Configuring...');
}

async function assertDeviceIsCompatible(deviceIp: string): Promise<void> {
	const { exitWithExpectedError } = await import('../utils/patterns');
	try {
		await execBuffered(deviceIp, 'os-config --version');
	} catch (err) {
		exitWithExpectedError(stripIndent`
			Device "${deviceIp}" is incompatible and cannot join or leave an application.
			Please select or provision device with balenaOS newer than ${MIN_BALENAOS_VERSION}.`);
	}
}

async function getDeviceType(deviceIp: string): Promise<string> {
	const output = await execBuffered(deviceIp, 'cat /etc/os-release');
	const match = /^SLUG="([^"]+)"$/m.exec(output);
	if (!match) {
		throw new Error('Failed to determine device type');
	}
	return match[1];
}

async function getOsVersion(deviceIp: string): Promise<string> {
	const output = await execBuffered(deviceIp, 'cat /etc/os-release');
	const match = /^VERSION_ID="([^"]+)"$/m.exec(output);
	if (!match) {
		throw new Error('Failed to determine OS version ID');
	}
	return match[1];
}

async function getOrSelectLocalDevice(deviceIp?: string): Promise<string> {
	if (deviceIp) {
		return deviceIp;
	}

	const through = await import('through2');

	let ip: string | null = null;
	const stream = through(function(data, _enc, cb) {
		const match = /^==> Selected device: (.*)$/m.exec(data.toString());
		if (match) {
			ip = match[1];
			cb();
		} else {
			cb(null, data);
		}
	});

	stream.pipe(process.stderr);

	const { sudo } = await import('../utils/helpers');
	const command = process.argv.slice(0, 2).concat(['internal', 'scandevices']);
	await sudo(command, {
		stderr: stream,
		msg:
			'Scanning for local devices. If asked, please type your computer password.',
	});

	if (!ip) {
		throw new Error('No device selected');
	}

	return ip;
}

async function selectAppFromList(applications: BalenaSdk.Application[]) {
	const _ = await import('lodash');
	const { selectFromList } = await import('../utils/patterns');

	// Present a list to the user which shows the fully qualified application
	// name (user/appname) and allows them to select.
	return selectFromList(
		'Select application',
		_.map(applications, app => {
			return _.merge({ name: app.slug }, app);
		}),
	);
}

async function getOrSelectApplication(
	sdk: BalenaSdk.BalenaSDK,
	deviceType: string,
	appName?: string,
): Promise<BalenaSdk.Application> {
	const _ = await import('lodash');
	const form = await import('resin-cli-form');

	const allDeviceTypes = await sdk.models.config.getDeviceTypes();
	const deviceTypeManifest = _.find(allDeviceTypes, { slug: deviceType });
	if (!deviceTypeManifest) {
		throw new Error(`"${deviceType}" is not a valid device type`);
	}
	const compatibleDeviceTypes = _(allDeviceTypes)
		.filter({ arch: deviceTypeManifest.arch })
		.map(type => type.slug)
		.value();

	if (!appName) {
		return createOrSelectAppOrExit(
			form,
			sdk,
			compatibleDeviceTypes,
			deviceType,
		);
	}

	const options: BalenaSdk.PineOptionsFor<BalenaSdk.Application> = {};

	// Check for an app of the form `user/application` and update the API query.
	let name: string;
	const match = appName.split('/');
	if (match.length > 1) {
		// These will match at most one app
		options.$filter = { slug: appName.toLowerCase() };
		name = match[1];
	} else {
		// We're given an application; resolve it if it's ambiguous and also validate
		// it's of appropriate device type.
		options.$filter = { app_name: appName };
		name = appName;
	}

	const applications = await sdk.models.application.getAll(options);

	if (applications.length === 0) {
		const shouldCreateApp = await form.ask({
			message:
				`No application found with name "${appName}".\n` +
				'Would you like to create it now?',
			type: 'confirm',
			default: true,
		});
		if (shouldCreateApp) {
			return createApplication(sdk, deviceType, name);
		}
		process.exit(1);
	}

	// We've found at least one app with the given name.
	// Filter out apps for non-matching device types and see what we're left with.
	const validApplications = applications.filter(app =>
		_.includes(compatibleDeviceTypes, app.device_type),
	);

	if (validApplications.length === 0) {
		throw new Error('No application found with a matching device type');
	}

	if (validApplications.length === 1) {
		return validApplications[0];
	}

	return selectAppFromList(applications);
}

// TODO: revisit this function's purpose. It was refactored out of
// `getOrSelectApplication` above in order to satisfy some resin-lint v3
// rules, but it looks like there's a fair amount of duplicate logic.
async function createOrSelectAppOrExit(
	form: any,
	sdk: BalenaSdk.BalenaSDK,
	compatibleDeviceTypes: string[],
	deviceType: string,
) {
	const options = {
		$filter: { device_type: { $in: compatibleDeviceTypes } },
	};

	// No application specified, show a list to select one.
	const applications = await sdk.models.application.getAll(options);

	if (applications.length === 0) {
		const shouldCreateApp = await form.ask({
			message:
				'You have no applications this device can join.\n' +
				'Would you like to create one now?',
			type: 'confirm',
			default: true,
		});
		if (shouldCreateApp) {
			return createApplication(sdk, deviceType);
		}
		process.exit(1);
	}

	return selectAppFromList(applications);
}

async function createApplication(
	sdk: BalenaSdk.BalenaSDK,
	deviceType: string,
	name?: string,
): Promise<BalenaSdk.Application> {
	const form = await import('resin-cli-form');
	const validation = await import('./validation');
	const patterns = await import('./patterns');

	let username = await sdk.auth.whoami();
	if (!username) {
		throw new sdk.errors.BalenaNotLoggedIn();
	}
	username = username.toLowerCase();

	const applicationName = await new Promise<string>(async (resolve, reject) => {
		while (true) {
			try {
				const appName = await form.ask({
					message: 'Enter a name for your new application:',
					type: 'input',
					default: name,
					validate: validation.validateApplicationName,
				});

				try {
					await sdk.models.application.get(appName, {
						$filter: {
							$or: [
								{ slug: { $startswith: `${username}/` } },
								{ $not: { slug: { $contains: '/' } } },
							],
						},
					});
					patterns.printErrorMessage(
						'You already have an application with that name; please choose another.',
					);
					continue;
				} catch (err) {
					return resolve(appName);
				}
			} catch (err) {
				return reject(err);
			}
		}
	});

	return sdk.models.application.create({
		name: applicationName,
		deviceType,
	});
}

async function generateApplicationConfig(
	sdk: BalenaSdk.BalenaSDK,
	app: BalenaSdk.Application,
	options: { version: string },
) {
	const form = await import('resin-cli-form');
	const { generateApplicationConfig: configGen } = await import('./config');

	const manifest = await sdk.models.device.getManifestBySlug(app.device_type);
	const opts =
		manifest.options && manifest.options.filter(opt => opt.name !== 'network');
	const values = {
		...(opts ? await form.run(opts) : {}),
		...options,
	};

	const config = await configGen(app, values);
	if (config.connectivity === 'connman') {
		delete config.connectivity;
		delete config.files;
	}

	return config;
}
