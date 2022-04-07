/*  Copyright (c) 2022 Mitya Selivanov
 */

'use strict';

const https_proxy_agent = require('https-proxy-agent');
const socks_proxy_agent = require('socks-proxy-agent');

const default_fetch_upstream    = require('node-fetch');
const default_rotate_threshold  = 0;
const default_fail_threshold    = 5;
const default_check_enabled     = true;
const default_check_url         = 'https://google.com';
const default_check_threshold   = 3;
const default_ipify_enabled     = true;
const default_proxy_protocol    = 'http';

function default_on_rotate(proxy) { }

function default_on_error(error) {
  console.error(error);
}

const options = {
  fetch_upstream:   default_fetch_upstream,
  rotate_threshold: default_rotate_threshold,
  fail_threshold:   default_fail_threshold,
  check_enabled:    default_check_enabled,
  check_url:        default_check_url,
  check_threshold:  default_check_threshold,
  ipify_enabled:    default_ipify_enabled,
  default_protocol: default_proxy_protocol,
  on_rotate:        default_on_rotate,
  on_error:         default_on_error
};

const ipify_request_url = 'https://api.ipify.org/?format=json';

let proxy_list  = [];
let proxy_index = 0;
let fetch_count = 0;
let fail_count  = 0;

function wrap_ip(s) {
  if (s.includes(':'))
    return `[${s}]`;
  return s;
}

function create_url(data) {
  if (data.username)
    return new URL(
      `${data.protocol}` +
      `${data.username}:${data.password}@` +
      `${wrap_ip(data.hostname)}:${data.port}`);
  return new URL(`${data.protocol}${wrap_ip(data.hostname)}:${data.port}`);
}

function parse_simple(info) {
  let v = [];
  let s = '';

  let depth = 0;

  for (let i = 0; i < info.length; i++) {
    if (info[i] == '@' && depth == 0)
      throw new Error('Invalid format.');

    if (info[i] == '[' && depth == 0 && s == '') {
      depth++;
      continue;
    }

    if (info[i] == ']' && depth == 1 &&
        (i + 1 == info.length || info[i + 1] == ':')) {
      depth--;
      continue;
    }

    if (info[i] == ':' && depth == 0) {
      if (i + 2 < info.length &&
          info[i + 1] == '/' && 
          info[i + 2] == '/') {
        s += '://';
        i += 2;
      }
      v[v.length] = s;
      s = '';
      continue;
    }

    s += info[i];
  }

  if (v.length < 3)
    throw new Error('Invalid format.');
  if (!v[0].includes('://'))
    throw new Error('Invalid format.');
  
  let data = {
    protocol: v[0],
    hostname: v[1],
    port:     v[2]
  };

  if (v.length == 5) {
    data.username = v[3];
    data.password = v[4];
  } else if (v.length != 3) {
    throw new Error('Invalid format.');
  }

  return create_url(data);
}

function normalize(url) {
  if (!url.protocol)
    return create_url({
      ...url,
      protocol: `${options.default_protocol}://`
    });

  return url;
}

function parse(url) {
  if (typeof url !== 'string')
    return normalize(url);

  if (!/^\w+\:\/\//.test(url))
    return parse(`${options.default_protocol}://${url}`);

  try {
    return parse_simple(url);
  } catch (error) {
    return new URL(url);
  }
}

function init_proxy(url) {
  let proxy = {
    url: url
  };
  if (/^https?$/.test(url.protocol))
    proxy.agent = new https_proxy_agent(url);
  else if (/^socks.*/.test(url.protocol))
    proxy.agent = new socks_proxy_agent(url);
  else
    throw new Error(`Protocol not supported: ${url.protocol}`);
  return proxy;
}

function setup(proxies) {
  proxy_list  = [];
  proxy_index = 0;

  for (const url of proxies) {
    try {
      proxy_list[proxy_index] = init_proxy(parse(url));
      proxy_index++;
    } catch (error) {
      if (options.on_error)
        options.on_error(error);
    }
  }

  proxy_index = 0;
}

var get_current_proxy;
var rotate;

async function success() {
  if (options.rotate_threshold <= 0)
    return;

  fetch_count++;

  if (fetch_count >= options.rotate_threshold)
    await rotate();
}

async function fail() {
  if (options.fail_threshold <= 0)
    return;

  fail_count++;

  if (fail_count >= options.fail_threshold)
    await rotate();
}

function wrap_options(options) {
  return {
    ...options,
    agent: get_current_proxy().agent
  };
}

function fetch(url, options) {
  return options.fetch_upstream(url, wrap_options(options))
    .then(response => {
      return success().then(() => {
        return response;
      });
    })
    .catch(error => {
      return fail().then(() => {
        throw error;
      });
    });
}

async function check() {
  try {
    for (let i = 0; i < options.check_threshold; i++) {
      try {
        const response = await fetch(check_url);
        if (response.ok)
          return true;
        if (options.on_error)
          options.on_error(await response.text());
      } catch (error) {
        if (options.on_error)
          options.on_error(error);
      }
    }
  } catch (error) {
    if (options.on_error)
      options.on_error(error);
  }

  return false;
}

get_current_proxy = function() {
  if (proxy_index < 0 || proxy_index >= proxy_list.length)
    return {};

  return proxy_list[proxy_index];
};

async function get_public_ip() {
  let final_error = new Error('Unknown error');

  for (let i = 0; i < options.check_threshold; i++) {
    try {
      const response = await fetch(ipify_request_url);
      if (response.ok)
        return (await response.json()).ip;
      if (options.on_error) {
        final_error = await response.text();
        options.on_error(final_error);
      }
    } catch (error) {
      if (options.on_error)
        options.on_error(error);
      final_error = error;
    }
  }

  throw final_error;
}

rotate = async () => {
  fetch_count = 0;
  fail_count  = 0;

  for (let i = 1; i < proxy_list.length; i++) {
    proxy_index = (proxy_index + 1) % proxy_list.length;

    if (await check()) {
      if (options.ipify_enabled)
        get_current_proxy().public_ip = await get_public_ip();
      if (options.on_rotate)
        options.on_rotate(get_current_proxy());
      return;
    }
  }
};

module.exports = {
  _internal: {
    success:  success,
    fail:     fail,
  },
  parse:              parse,
  setup:              setup,
  wrap_options:       wrap_options,
  fetch:              fetch,
  check:              check,
  get_current_proxy:  get_current_proxy,
  get_public_ip:      get_public_ip,
  rotate:             rotate,
  options:            options
};
