'use strict';
// SPDX-License-Identifier: AGPL-3.0-only

'require view';
'require ui';
'require uci';
'require rpc';
'require fs';
'require nginx-manager/utils as utils';

var callGetSite = rpc.declare({
	object: 'nginx_manager',
	method: 'get_site',
	params: ['id'],
	expect: {}
});

var callSetSite = rpc.declare({
	object: 'nginx_manager',
	method: 'set_site',
	params: ['id', 'name', 'mode', 'server_name', 'listen_addr', 'listen_port', 'proxy_path', 'proxy_pass', 'root', 'index',
		'websocket', 'proxy_type', 'grpc_path', 'grpc_pass', 'custom_proxy_headers', 'redirect_https', 'redirect_http_port', 'proxy_host', 'proxy_xff', 'proxy_xfp', 'proxy_xri',
		'ssl_cert', 'ssl_protocols', 'ssl_ciphers', 'hsts_max_age',
		'access_log', 'error_log', 'custom_server_block', 'redirect_target', 'enabled',
		'proxy_connect_timeout', 'proxy_read_timeout', 'proxy_send_timeout', 'locations',
		'sync_hosts', 'hosts_ip'],
	expect: {}
});

var callListCerts = rpc.declare({
	object: 'nginx_manager',
	method: 'list_certs',
	expect: {}
});

var callRenderSite = rpc.declare({
	object: 'nginx_manager',
	method: 'render_site',
	params: ['id'],
	expect: {}
});

var callSaveFile = rpc.declare({
	object: 'nginx_manager',
	method: 'save_file',
	params: ['path', 'content'],
	expect: {}
});

return view.extend({
	load: function() {
		var siteId = L.env.pathinfo ? L.env.pathinfo.split('/').pop() : null;
		if (!siteId && window.location.hash) {
			var parts = window.location.hash.split('/');
			siteId = parts[parts.length - 1];
		}

		var promises = [callListCerts(), uci.load('network').catch(function() { return null; })];

		if (siteId) {
			promises.push(callGetSite(siteId));
		} else {
			promises.push(Promise.resolve(null));
		}

		return Promise.all(promises);
	},

	render: function(data) {
		var certs = (data[0] && data[0].certs) || [];
		var site = data[2];
		var isNew = !site || !!site.error;
		var lanIp = (uci.get('network', 'lan', 'ipaddr') || '192.168.1.1');

		var siteId = '';
		if (L.env.pathinfo) {
			siteId = L.env.pathinfo.split('/').pop();
		}
		if (!siteId && window.location.hash) {
			siteId = window.location.hash.split('/').pop();
		}

		var page = E('div', { 'class': 'cbi-map nm-site-edit' });

		utils.loadSharedCSS();
		/* Keep the site-editor layout stylesheet fresh when this view is deployed
		 * directly to a router instead of through a package upgrade. */
		var sharedCss = document.getElementById('nm-shared-css');
		if (sharedCss)
			sharedCss.href = L.resource('nginx-manager/nginx-manager.css') + '?v=site-editor-location-layout-4';

		page.appendChild(E('h2', { 'class': 'cbi-map-title' }, isNew ? _('Add Site') : _('Edit Site')));

		/* ---- helpers ---- */

		function makeField(id, label, inputEl, desc) {
			var row = E('div', { 'class': 'cbi-value' });
			row.appendChild(E('label', { 'class': 'cbi-value-title', 'for': id }, label));
			var field = E('div', { 'class': 'cbi-value-field' });
			inputEl.id = id;
			field.appendChild(inputEl);
			if (desc)
				field.appendChild(E('div', { 'class': 'cbi-value-description' }, desc));
			row.appendChild(field);
			return row;
		}

		function makeFlag(id, label, checked) {
			var row = E('div', { 'class': 'cbi-value' });
			row.appendChild(E('label', { 'class': 'cbi-value-title', 'for': id }, label));
			var field = E('div', { 'class': 'cbi-value-field' });
			var cb = E('input', { 'type': 'checkbox', 'id': id, 'class': 'cbi-input-checkbox' });
			if (checked) cb.checked = true;
			field.appendChild(cb);
			row.appendChild(field);
			return row;
		}

		/* ---- conditional sections ---- */
		var sslSection, proxySection, staticSection, redirectSection, customSection;

		/* references for visibility updates */
		var locationsContainer;

		function updateVisibility() {
			var mode = modeSelect.value;
			sslSection.style.display      = (mode === 'reverse_proxy' || mode === 'static') ? '' : 'none';
			proxySection.style.display    = mode === 'reverse_proxy' ? '' : 'none';
			staticSection.style.display   = mode === 'static'        ? '' : 'none';
			redirectSection.style.display = mode === 'redirect'      ? '' : 'none';
			customSection.style.display   = mode === 'custom'        ? '' : 'none';
		}

		/* ========== Basic Settings ========== */
		var basicSection = E('div', { 'class': 'cbi-section' });
		basicSection.appendChild(E('h3', {}, _('Basic Settings')));

		basicSection.appendChild(makeFlag('opt-enabled', _('Enabled'),
			isNew ? true : site && site.enabled === '1'));

		var nameInput = E('input', { 'type': 'text', 'class': 'cbi-input-text' });
		if (isNew && siteId) nameInput.value = siteId;
		if (!isNew && site && site.name) nameInput.value = site.name;
		basicSection.appendChild(makeField('opt-name', _('Site Name'), nameInput, utils.NAME_TIP));
		utils.validateNameInput(nameInput);

		var modeSelect = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': 'reverse_proxy' }, _('Reverse Proxy')),
			E('option', { 'value': 'static' },        _('Static Website')),
			E('option', { 'value': 'custom' },        _('Custom Server Block')),
			E('option', { 'value': 'redirect' },      _('Redirect'))
		]);
		if (!isNew && site && site.mode) modeSelect.value = site.mode;
		modeSelect.addEventListener('change', updateVisibility);
		basicSection.appendChild(makeField('opt-mode', _('Type'), modeSelect));

		var serverNameInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': 'example.com' });
		if (!isNew && site && site.server_name) serverNameInput.value = site.server_name;
		basicSection.appendChild(makeField('opt-server_name', _('Domain'), serverNameInput));

		/* Hosts Sync */
		var syncHostsRow = makeFlag('opt-sync_hosts', _('Add to Local Hosts'),
			isNew ? true : (site && site.sync_hosts === '1'));
		var syncHostsCb = syncHostsRow.querySelector('input[type="checkbox"]');
		basicSection.appendChild(syncHostsRow);

		var hostsIpInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'placeholder': lanIp
		});
		if (!isNew && site && site.hosts_ip) {
			hostsIpInput.value = site.hosts_ip;
		}
		var hostsIpRow = makeField('opt-hosts_ip', _('Hosts Target IP'), hostsIpInput,
			_('Automatically add/update domain mapping in /etc/hosts (defaults to router LAN IP).'));
		basicSection.appendChild(hostsIpRow);

		function updateHostsIpVisibility() {
			hostsIpRow.style.display = syncHostsCb.checked ? '' : 'none';
		}
		syncHostsCb.addEventListener('change', updateHostsIpVisibility);
		updateHostsIpVisibility();

		/* Listen Address — optional IP to bind to */
		var listenAddrInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': _('All interfaces') });
		if (!isNew && site && site.listen_addr) listenAddrInput.value = site.listen_addr;
		basicSection.appendChild(makeField('opt-listen_addr', _('Listen Address'), listenAddrInput,
			_('Leave empty for all interfaces, or specify an IP (e.g. 127.0.0.1).')));

		/* Listen Port */
		var listenPortInput = E('input', { 'type': 'number', 'class': 'cbi-input-text', 'min': '1', 'max': '65535', 'placeholder': '80' });
		if (!isNew && site && site.listen_port) {
			listenPortInput.value = site.listen_port;
		} else {
			listenPortInput.value = '80';
		}
		basicSection.appendChild(makeField('opt-listen_port', _('Listen Port'), listenPortInput,
			_('SSL can be enabled on any port, no need to switch to 443.')));

		page.appendChild(basicSection);

		/* ========== SSL Settings ========== */
		sslSection = E('div', { 'class': 'cbi-section' });
		sslSection.appendChild(E('h3', {}, _('SSL Settings')));

		var sslCertSelect = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': '' }, _('-- None --'))
		]);
		certs.forEach(function(cert) {
			sslCertSelect.appendChild(E('option', { 'value': cert.id },
				cert.name + (cert.domain ? ' (' + cert.domain + ')' : '')));
		});
		if (!isNew && site && site.ssl_cert) sslCertSelect.value = site.ssl_cert;
		sslSection.appendChild(makeField('opt-ssl_cert', _('SSL Certificate'), sslCertSelect));

		var sslWarning = E('div', { 'class': 'alert-message warning', 'style': 'display:none;' });
		sslSection.appendChild(sslWarning);

		sslCertSelect.addEventListener('change', function() {
			var sel = certs.find(function(c) { return c.id === sslCertSelect.value; });
			if (sel && (sel.status === 'expiring' || sel.status === 'expired')) {
				sslWarning.style.display = '';
				sslWarning.textContent = sel.status === 'expired'
					? _('This certificate has expired.')
					: _('This certificate is expiring soon.');
			} else {
				sslWarning.style.display = 'none';
			}

			/* Auto-update listen defaults when SSL is toggled */
			updateListenDefaults();
		});

		var redirectHttpsRow = makeFlag('opt-redirect_https', _('HTTP to HTTPS Redirect'),
			!isNew && site ? site.redirect_https === '1' : true);
		var redirectHttpsCb = redirectHttpsRow.querySelector('input[type="checkbox"]');
		sslSection.appendChild(redirectHttpsRow);

		var redirectHttpPortInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'placeholder': _('Leave empty to use same-port redirect.')
		});
		if (!isNew && site && site.redirect_http_port) redirectHttpPortInput.value = site.redirect_http_port;
		var redirectHttpPortRow = makeField('opt-redirect_http_port', _('HTTP Redirect Port'), redirectHttpPortInput,
			_('Leave empty to use same-port redirect.'));
		sslSection.appendChild(redirectHttpPortRow);

		function updateRedirectHttpPortVisibility() {
			redirectHttpPortRow.style.display = redirectHttpsCb.checked ? '' : 'none';
		}
		redirectHttpsCb.addEventListener('change', updateRedirectHttpPortVisibility);
		updateRedirectHttpPortVisibility();

		/* SSL Advanced Options */
		var sslAdvancedWrapper = E('div', { 'style': 'display:none;' });

		var sslProtocolsInput = E('input', {
			'type': 'text', 'class': 'cbi-input-text',
			'placeholder': 'TLSv1.2 TLSv1.3',
			'value': !isNew && site ? (site.ssl_protocols || '') : ''
		});
		sslAdvancedWrapper.appendChild(makeField('opt-ssl_protocols', _('SSL Protocols'), sslProtocolsInput,
			_('Leave empty to use default: TLSv1.2 TLSv1.3')));

		var sslCiphersInput = E('input', {
			'type': 'text', 'class': 'cbi-input-text',
			'placeholder': 'ECDHE-ECDSA-AES128-GCM-SHA256:...',
			'value': !isNew && site ? (site.ssl_ciphers || '') : ''
		});
		sslAdvancedWrapper.appendChild(makeField('opt-ssl_ciphers', _('SSL Ciphers'), sslCiphersInput,
			_('Leave empty to use default ciphers.')));

		var hstsMaxAgeInput = E('input', {
			'type': 'text', 'class': 'cbi-input-text',
			'placeholder': '31536000'
		});
		if (!isNew && site && site.hsts_max_age) hstsMaxAgeInput.value = site.hsts_max_age;
		sslAdvancedWrapper.appendChild(makeField('opt-hsts_max_age', _('HSTS Max-Age'), hstsMaxAgeInput,
			_('HSTS max-age in seconds. Default: 31536000 (1 year). Set to 0 to disable.')));

		sslSection.appendChild(sslAdvancedWrapper);

		function updateSslAdvancedVisibility() {
			var hasCert = sslCertSelect.value !== '';
			sslAdvancedWrapper.style.display = hasCert ? '' : 'none';
		}
		sslCertSelect.addEventListener('change', updateSslAdvancedVisibility);
		updateSslAdvancedVisibility();

		page.appendChild(sslSection);

		/* Helper */
		function updateListenDefaults() {
			// Port stays as-is when toggling SSL; nginx adds ssl flag to any port
		}

		/* ========== Reverse Proxy ========== */
		proxySection = E('div', { 'class': 'cbi-section' });
		proxySection.appendChild(E('h3', {}, _('Reverse Proxy')));
		proxySection.appendChild(E('div', { 'class': 'cbi-value-description', 'style': 'margin-bottom:0.75em;' },
			_('Each card is one nginx location. Configure its path, backend, WebSocket, common headers, and any location-specific directives independently.')));
		locationsContainer = E('div', { 'class': 'nm-location-cards' });
		proxySection.appendChild(locationsContainer);

		function makeToggle(label, value, attribute, extraClass) {
			var input = E('input', { 'type': 'checkbox', 'class': 'cbi-input-checkbox' });
			input.checked = value === '1';
			input.setAttribute(attribute, '1');
			return E('div', {
				'class': 'nm-location-toggle' + (extraClass ? ' ' + extraClass : ''),
				'click': function(ev) {
					if (ev.target !== input)
						input.checked = !input.checked;
				}
			}, [E('span', {}, label), input]);
		}

		function makeHostSelect(value, dataAttr) {
			var currentVal = value || 'http_host';
			if (currentVal === '1' || currentVal === '$http_host') currentVal = 'http_host';
			if (currentVal === '0') currentVal = 'off';
			if (currentVal === '$host') currentVal = 'host';

			var select = E('select', {
				'class': 'cbi-input-select',
				'style': 'width:auto; margin:0 0.4em 0 0.2em; padding:2px 6px; font-size:90%; height:auto;'
			}, [
				E('option', { 'value': 'http_host' }, '$http_host (' + _('Preserve Port') + ')'),
				E('option', { 'value': 'host' }, '$host (' + _('Domain Only') + ')'),
				E('option', { 'value': 'off' }, _('Disabled'))
			]);
			select.setAttribute(dataAttr, '1');
			select.value = currentVal;
			return E('div', {
				'class': 'nm-location-toggle',
				'style': 'display:inline-flex; align-items:center; gap:0.25em;'
			}, [
				E('span', {}, 'Host:'),
				select
			]);
		}

		function addLocationCard(location, isPrimary) {
			location = location || {};
			var pathInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'data-location-path': '1', 'placeholder': '/' });
			var backendInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'data-location-backend': '1', 'placeholder': 'http://127.0.0.1:8000/' });
			var websocketControl = makeToggle(_('WebSocket'), location.websocket || '0', 'data-location-websocket', 'nm-location-websocket');
			var websocketInput = websocketControl.querySelector('input');
			var directivesInput = E('textarea', {
				'class': 'cbi-input-textarea', 'rows': 3, 'data-location-directives': '1',
				'placeholder': 'proxy_set_header Host $http_host;\nproxy_read_timeout 1200s;\nclient_max_body_size 0;'
			});
			pathInput.value = location.path || '/';
			backendInput.value = location.proxy_pass || '';
			websocketInput.checked = location.websocket === '1';
			directivesInput.value = location.directives || '';
			var defaultHeaders = {
				proxy_host: (!isNew && site && site.proxy_host) || 'http_host',
				proxy_xff: (!isNew && site && site.proxy_xff) || '1',
				proxy_xfp: (!isNew && site && site.proxy_xfp) || '1',
				proxy_xri: (!isNew && site && site.proxy_xri) || '1'
			};
			var headerRow = E('div', { 'class': 'nm-location-header-row', 'style': 'display:flex; flex-wrap:wrap; align-items:center; gap:0.4em; margin-top:0.35em;' }, [
				E('span', { 'style': 'color:#666; margin-right:0.2em;' }, _('Headers:')),
				makeHostSelect(location.proxy_host || defaultHeaders.proxy_host, 'data-location-proxy-host'),
				makeToggle('X-Forwarded-For', location.proxy_xff || defaultHeaders.proxy_xff, 'data-location-proxy-xff'),
				makeToggle('X-Forwarded-Proto', location.proxy_xfp || defaultHeaders.proxy_xfp, 'data-location-proxy-xfp'),
				makeToggle('X-Real-IP', location.proxy_xri || defaultHeaders.proxy_xri, 'data-location-proxy-xri')
			]);
			var headerHint = E('div', { 'class': 'cbi-value-description', 'style': 'margin-top:0.2em;' },
				_('Disable a common header here before redefining that same header in Location Directives.'));
			var removeButton = E('button', {
				'class': 'cbi-button cbi-button-remove',
				'click': function() { row.remove(); updateRemoveButtons(); }
			}, _('Remove'));
			var topRow = E('div', { 'class': 'nm-location-top-row' }, [
				E('label', { 'style': 'display:flex; flex:1 1 10em; flex-direction:column; gap:0.2em;' }, [_('Path'), pathInput]),
				E('label', { 'style': 'display:flex; flex:2 1 18em; flex-direction:column; gap:0.2em;' }, [_('Backend Address'), backendInput]),
				websocketControl,
				removeButton
			]);
			var row = E('div', { 'class': 'nm-location-card cbi-section', 'style': 'margin:0 0 0.65em; padding:0.65em 0.75em;' }, [
				topRow,
				headerRow,
				headerHint,
				E('details', { 'style': 'margin-top:0.45em;' }, [
					E('summary', {}, _('Location Directives')),
					E('div', { 'style': 'margin-top:0.4em;' }, [directivesInput]),
					E('div', { 'class': 'cbi-value-description' }, _('Added only to this location. Use proxy_set_header, client_max_body_size, timeouts, and other location directives.'))
				])
			]);
			row.setAttribute('data-primary-location', isPrimary ? '1' : '0');
			locationsContainer.appendChild(row);
			updateRemoveButtons();
		}

		function updateRemoveButtons() {
			var cards = locationsContainer ? locationsContainer.querySelectorAll('.nm-location-card') : [];
			for (var i = 0; i < cards.length; i++) {
				var button = cards[i].querySelector('.cbi-button-remove');
				button.disabled = cards.length === 1;
			}
		}

		var storedLocations = (!isNew && site && Array.isArray(site.locations)) ? site.locations : [];
		var v2Locations = storedLocations.filter(function(location) { return location.format === 'v2'; });
		if (v2Locations.length) {
			v2Locations.forEach(function(location, index) { addLocationCard(location, index === 0); });
		} else {
			addLocationCard({
				path: (!isNew && site && site.proxy_path) || '/',
				proxy_pass: (!isNew && site && site.proxy_pass) || '',
				websocket: (!isNew && site && site.websocket) || '0',
				directives: (!isNew && site && site.custom_proxy_headers) || ''
			}, true);
			storedLocations.forEach(function(location) { addLocationCard(location, false); });
		}
		proxySection.appendChild(E('button', {
			'class': 'cbi-button', 'style': 'margin-top:0.1em;', 'click': function() { addLocationCard({ path: '/api/' }, false); }
		}, '+ ' + _('Add Location')));

		page.appendChild(proxySection);

		/* ========== Static Website ========== */
		staticSection = E('div', { 'class': 'cbi-section' });
		staticSection.appendChild(E('h3', {}, _('Static Website')));

		var rootInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': '/www/mysite' });
		if (!isNew && site && site.root) rootInput.value = site.root;
		staticSection.appendChild(makeField('opt-root', _('Root Directory'), rootInput));

		var indexInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': 'index.html' });
		if (!isNew && site && site.index) indexInput.value = site.index;
		else indexInput.value = 'index.html';
		staticSection.appendChild(makeField('opt-index', _('Index File'), indexInput));

		page.appendChild(staticSection);

		/* ========== Redirect ========== */
		redirectSection = E('div', { 'class': 'cbi-section' });
		redirectSection.appendChild(E('h3', {}, _('Redirect')));

		var redirectTargetInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': 'https://example.com' });
		if (!isNew && site && site.redirect_target) redirectTargetInput.value = site.redirect_target;
		redirectSection.appendChild(makeField('opt-redirect_target', _('Redirect Target'), redirectTargetInput));

		page.appendChild(redirectSection);

		/* ========== Custom Server Block ========== */
		customSection = E('div', { 'class': 'cbi-section' });
		customSection.appendChild(E('h3', {}, _('Custom Server Block')));

		var customBlockInput = E('textarea', {
			'class': 'cbi-input-textarea',
			'rows': 20,
			'spellcheck': 'false',
			'placeholder': 'server {\n    listen 80;\n    server_name example.com;\n\n    location / {\n        proxy_pass http://127.0.0.1:3000;\n    }\n}'
		});
		customBlockInput.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
		if (!isNew && site && site.custom_server_block)
			customBlockInput.value = site.custom_server_block;

		var customBlockEditorRow = E('div', { 'class': 'cbi-value' });
		customBlockEditorRow.appendChild(E('label', { 'class': 'cbi-value-title' }, _('Custom Server Block Content')));
		var customBlockEditorField = E('div', { 'class': 'cbi-value-field' });
		customBlockEditorField.appendChild(customBlockInput);
		customBlockEditorRow.appendChild(customBlockEditorField);
		customSection.appendChild(customBlockEditorRow);

		page.appendChild(customSection);

		/* ========== Logging ========== */
		var loggingSection = E('div', { 'class': 'cbi-section' });
		loggingSection.appendChild(E('h3', {}, _('Logging')));

		loggingSection.appendChild(makeFlag('opt-access_log', _('Access Log'),
			!isNew && site ? site.access_log === '1' : true));

		loggingSection.appendChild(makeFlag('opt-error_log', _('Error Log'),
			!isNew && site ? site.error_log === '1' : true));

		page.appendChild(loggingSection);

		/* ========== Config File ========== */
		if (!isNew) {
			var configSection = E('div', { 'class': 'cbi-section' });
			configSection.appendChild(E('h3', {}, _('Config File')));

			var configPath = site.config_path || '';
			var configPathRow = E('div', { 'class': 'cbi-value' });
			configPathRow.appendChild(E('label', { 'class': 'cbi-value-title' }, _('File Path')));
			var configPathField = E('div', { 'class': 'cbi-value-field' });
			configPathField.appendChild(E('code', { 'style': 'word-break:break-all;' }, configPath || '-'));
			configPathRow.appendChild(configPathField);
			configSection.appendChild(configPathRow);

			/* Enable edit checkbox */
			var enableEditRow = E('div', { 'class': 'cbi-value' });
			enableEditRow.appendChild(E('label', { 'class': 'cbi-value-title' }, _('Direct Edit')));
			var enableEditField = E('div', { 'class': 'cbi-value-field' });
			var enableEditCb = E('input', { 'type': 'checkbox', 'id': 'opt-enable_config_edit', 'class': 'cbi-input-checkbox' });
			enableEditField.appendChild(enableEditCb);
			enableEditField.appendChild(E('label', { 'for': 'opt-enable_config_edit', 'style': 'margin-left:0.4em;cursor:pointer;' }, _('Enable direct editing of the config file')));
			enableEditRow.appendChild(enableEditField);
			configSection.appendChild(enableEditRow);

			/* Warning */
			var configWarning = E('div', { 'class': 'alert-message warning', 'style': 'display:none;' });
			configWarning.appendChild(E('p', {}, _('Direct edits are temporary and will be overwritten whenever managed configuration is applied. Use Custom Location Directives for persistent reverse-proxy changes.')));

			/* Code editor - wrapped in cbi-value row to align with form fields */
			var configEditor = utils.createCodeEditor('', configPath || 'site.conf', { readonly: true });

			/* Save button for config file */
			var configSaveBtn = E('button', {
				'class': 'cbi-button cbi-button-apply',
				'style': 'display:none; margin-top:0.5em;',
				'click': function() {
					if (!configPath) {
						ui.addNotification(null, E('p', {}, _('Config file path not available')), 'error');
						return;
					}
					callSaveFile(configPath, configEditor.textarea.value).then(function(result) {
						if (result && result.error) {
							ui.addNotification(null, E('p', {}, _('Save failed') + ': ' + result.error), 'error');
						} else {
							ui.addNotification(null, E('p', {}, _('Config file saved successfully')), 'info');
						}
					}).catch(function(err) {
						ui.addNotification(null, E('p', {}, _('Save failed') + ': ' + (err.message || err)), 'error');
					});
				}
			}, _('Save Config File'));

			var configEditorRow = E('div', { 'class': 'cbi-value' });
			configEditorRow.appendChild(E('label', { 'class': 'cbi-value-title' }, _('Content')));
			var configEditorField = E('div', { 'class': 'cbi-value-field' });
			configEditorField.appendChild(configWarning);
			configEditorField.appendChild(configEditor.container);
			configEditorField.appendChild(configSaveBtn);
			configEditorRow.appendChild(configEditorField);
			configSection.appendChild(configEditorRow);

			/* Toggle edit mode */
			enableEditCb.addEventListener('change', function() {
				var edit = enableEditCb.checked;
				configEditor.setReadonly(!edit);
				configWarning.style.display = edit ? '' : 'none';
				configSaveBtn.style.display = edit ? '' : 'none';
			});

			/* Load config file content */
			if (configPath) {
				fs.read(configPath).then(function(content) {
					configEditor.setContent(content || '');
				}).catch(function() {
					configEditor.setContent(_('Config file not found. It will be created after saving the site.'));
				});
			}

			page.appendChild(configSection);
		}

		/* ========== Actions ========== */
		var actionsDiv = E('div', { 'class': 'nm-btn-group', 'style': 'justify-content: flex-end; margin-top: 1.5em;' });

		if (!isNew) {
			actionsDiv.appendChild(E('button', {
				'class': 'cbi-button',
				'click': function() {
					callRenderSite(siteId).then(function(result) {
						var configText = (result && result.config) || '';
						var configFilePath = (result && result.config_path) || '';
						var editor = utils.createCodeEditor(configText, configFilePath || 'site.conf', { readonly: true });

						var editBtn = E('button', {
							'class': 'cbi-button',
							'click': function() {
								editor.setReadonly(false);
								editBtn.style.display = 'none';
								saveBtn.style.display = '';
							}
						}, _('Edit'));

						var saveBtn = E('button', {
							'class': 'cbi-button cbi-button-apply',
							'style': 'display:none;',
							'click': function() {
								if (!configFilePath) {
									utils.alert(_('Error'), _('Config file path not available'), 'error');
									return;
								}
								ui.showModal(_('Confirm Save'), [
									E('p', {}, _('Save changes to the config file?')),
									E('p', {}, _('A backup will be created before saving.')),
									E('p', { 'style': 'margin-top:0.5em;' }, _('Direct edits are temporary and will be overwritten whenever managed configuration is applied. Use Custom Location Directives for persistent reverse-proxy changes.')),
									E('div', { 'class': 'right' }, [
										E('button', {
											'type': 'button',
											'class': 'btn',
											'click': function(ev) {
												if (ev) {
													ev.preventDefault();
													ev.stopPropagation();
												}
												ui.hideModal();
											}
										}, _('Cancel')),
										E('button', {
											'class': 'cbi-button cbi-button-apply',
											'click': function() {
												ui.hideModal();
												callSaveFile(configFilePath, editor.textarea.value).then(function(r) {
													if (r && r.error) {
														utils.alert(_('Save failed'), r.error, 'error');
													} else {
														ui.addNotification(null, E('p', {}, _('Config file saved successfully')), 'info');
													}
												}).catch(function(err) {
													utils.alert(_('Save failed'), (err.message || err), 'error');
												});
											}
										}, _('Save'))
									])
								]);
							}
						}, _('Save'));

						ui.showModal(_('Generated Config'), [
							editor.container,
							E('div', { 'class': 'right' }, [
								editBtn,
								saveBtn,
								E('button', {
									'type': 'button',
									'class': 'btn',
									'click': function(ev) {
										if (ev) {
											ev.preventDefault();
											ev.stopPropagation();
										}
										ui.hideModal();
									}
								}, _('Close'))
							])
						]);
					});
				}
			}, '\u21BB ' + _('View Generated Config')));
		}

		actionsDiv.appendChild(E('button', {
			'class': 'cbi-button cbi-button-apply',
			'click': function() { saveSite(); }
		}, _('Save')));

		actionsDiv.appendChild(E('button', {
			'class': 'cbi-button cbi-button-reset',
			'click': function() {
				location.href = L.url('admin/services/nginx-manager/sites');
			}
		}, '\u2190 ' + _('Back to Sites')));

		page.appendChild(actionsDiv);

		/* initial visibility */
		updateVisibility();

		/* ---- save logic ---- */
		function encodeLocationDirectives(value) {
			var utf8 = unescape(encodeURIComponent(value));
			var encoded = '';
			for (var i = 0; i < utf8.length; i++)
				encoded += ('0' + utf8.charCodeAt(i).toString(16)).slice(-2);
			return encoded;
		}

		function showSaveError(detail) {
			function closeErrorModal(ev) {
				ev.preventDefault();
				ev.stopPropagation();
				if (document.activeElement)
					document.activeElement.blur();
				ui.hideModal();
			}

			ui.showModal(_('Configuration test failed'), [
				E('pre', { 'style': 'white-space:pre-wrap; overflow-wrap:anywhere; margin:0;' }, String(detail || _('Save failed'))),
				E('div', { 'class': 'right' }, [
					E('button', { 'type': 'button', 'class': 'cbi-button', 'click': closeErrorModal }, _('Close'))
				])
			]);
		}

		function saveSite() {
			var data = { id: siteId || document.getElementById('opt-name').value.trim() };

			data.enabled             = document.getElementById('opt-enabled').checked ? '1' : '0';
			data.name                = document.getElementById('opt-name').value.trim();

			if (!data.name) {
				utils.alert(_('Validation Error'), _('Site name is required'), 'error');
				return;
			}
			if (!utils.NAME_PATTERN.test(data.name)) {
				utils.alert(_('Validation Error'), _('Invalid site name'), 'error');
				return;
			}
			data.mode                = document.getElementById('opt-mode').value;
			data.server_name         = document.getElementById('opt-server_name').value.trim();

			data.listen_addr         = document.getElementById('opt-listen_addr').value.trim();
			data.listen_port         = document.getElementById('opt-listen_port').value.trim() || '80';

			data.ssl_cert            = document.getElementById('opt-ssl_cert').value;
			data.ssl_protocols       = document.getElementById('opt-ssl_protocols').value.trim();
			data.ssl_ciphers         = document.getElementById('opt-ssl_ciphers').value.trim();
			data.hsts_max_age        = document.getElementById('opt-hsts_max_age').value.trim();
			data.redirect_https      = document.getElementById('opt-redirect_https').checked ? '1' : '0';
			data.redirect_http_port  = document.getElementById('opt-redirect_http_port').value.trim();
			data.root                = document.getElementById('opt-root').value.trim();
			data.index               = document.getElementById('opt-index').value.trim();
			data.redirect_target     = document.getElementById('opt-redirect_target').value.trim();
			data.custom_server_block = customBlockInput.value;
			data.access_log          = document.getElementById('opt-access_log').checked ? '1' : '0';
			data.error_log           = document.getElementById('opt-error_log').checked ? '1' : '0';
			data.sync_hosts          = document.getElementById('opt-sync_hosts').checked ? '1' : '0';
			data.hosts_ip            = document.getElementById('opt-hosts_ip').value.trim();

			data.proxy_connect_timeout = (!isNew && site && site.proxy_connect_timeout) || '';
			data.proxy_read_timeout    = (!isNew && site && site.proxy_read_timeout) || '';
			data.proxy_send_timeout    = (!isNew && site && site.proxy_send_timeout) || '';
			var locationRows = locationsContainer.querySelectorAll('.nm-location-card');
			var locationLines = [];
			var locationPaths = {};
			for (var li = 0; li < locationRows.length; li++) {
				var locationPath = locationRows[li].querySelector('[data-location-path]').value.trim();
				var locationBackend = locationRows[li].querySelector('[data-location-backend]').value.trim();
				var locationWebsocket = locationRows[li].querySelector('[data-location-websocket]').checked ? '1' : '0';
				var locationDirectives = locationRows[li].querySelector('[data-location-directives]').value;
				var hostSelect = locationRows[li].querySelector('[data-location-proxy-host]');
				var locationProxyHost = hostSelect ? hostSelect.value : 'http_host';
				var locationProxyXff = locationRows[li].querySelector('[data-location-proxy-xff]').checked ? '1' : '0';
				var locationProxyXfp = locationRows[li].querySelector('[data-location-proxy-xfp]').checked ? '1' : '0';
				var locationProxyXri = locationRows[li].querySelector('[data-location-proxy-xri]').checked ? '1' : '0';
				if (data.mode !== 'reverse_proxy') break;
				if (!locationPath || !locationBackend || locationPaths[locationPath] || !/^\/[A-Za-z0-9._~!$&()*+,;=:@%/-]*$/.test(locationPath)) {
					utils.alert(_('Validation Error'), _('Each location needs a unique path and backend address'), 'error');
					return;
				}
				if (!/^(https?:\/\/|unix:|grpcs?:\/\/)/.test(locationBackend)) {
					utils.alert(_('Validation Error'), _('Location backend must use http://, https://, unix:, grpc://, or grpcs://'), 'error');
					return;
				}
				locationPaths[locationPath] = true;
				locationLines.push(locationPath + '|' + locationBackend + '|' + locationWebsocket + '|' + locationProxyHost + '|' + locationProxyXff + '|' + locationProxyXfp + '|' + locationProxyXri + '|' + encodeLocationDirectives(locationDirectives));
			}
			data.locations = locationLines.join('\n');
			var firstLocation = locationRows[0];
			data.proxy_path = firstLocation ? firstLocation.querySelector('[data-location-path]').value.trim() || '/' : '/';
			data.proxy_pass = firstLocation ? firstLocation.querySelector('[data-location-backend]').value.trim() : '';
			data.websocket = firstLocation && firstLocation.querySelector('[data-location-websocket]').checked ? '1' : '0';
			data.proxy_type = 'http';
			data.grpc_path = '';
			data.grpc_pass = '';
			data.custom_proxy_headers = '';
			var firstHostSelect = firstLocation ? firstLocation.querySelector('[data-location-proxy-host]') : null;
			data.proxy_host = firstHostSelect ? firstHostSelect.value : 'http_host';
			data.proxy_xff = firstLocation && firstLocation.querySelector('[data-location-proxy-xff]').checked ? '1' : '0';
			data.proxy_xfp = firstLocation && firstLocation.querySelector('[data-location-proxy-xfp]').checked ? '1' : '0';
			data.proxy_xri = firstLocation && firstLocation.querySelector('[data-location-proxy-xri]').checked ? '1' : '0';

			return callSetSite(
				data.id,
				data.name,
				data.mode,
				data.server_name,
				data.listen_addr,
				data.listen_port,
				data.proxy_path,
				data.proxy_pass,
				data.root,
				data.index,
				data.websocket,
				data.proxy_type,
				data.grpc_path,
				data.grpc_pass,
				data.custom_proxy_headers,
				data.redirect_https,
				data.redirect_http_port,
				data.proxy_host,
				data.proxy_xff,
				data.proxy_xfp,
				data.proxy_xri,
				data.ssl_cert,
				data.ssl_protocols,
				data.ssl_ciphers,
				data.hsts_max_age,
				data.access_log,
				data.error_log,
				data.custom_server_block,
				data.redirect_target,
				data.enabled,
				data.proxy_connect_timeout,
				data.proxy_read_timeout,
				data.proxy_send_timeout,
				data.locations,
				data.sync_hosts,
				data.hosts_ip
			).then(function(result) {
				if (result && result.error) {
					showSaveError(result.detail || result.error);
				} else {
					ui.addNotification(null, E('p', {}, _('Site saved successfully')), 'info');
					setTimeout(function() {
						location.href = L.url('admin/services/nginx-manager/sites');
					}, 800);
				}
			}).catch(function(err) {
				showSaveError(err.message || JSON.stringify(err));
			});
		}

		return utils.appendFooter(page, {
			project: 'Nginx Manager',
			repoUrl: 'https://github.com/hello-yunshu/luci-app-nginx-manager'
		});
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
