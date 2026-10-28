import { mkdir, lstat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readServerConfig } from './config.ts';

/** Generate reviewable files in a NEW directory; never install/reload a service. */
export async function generateDeployment(configPath: string, output: string, options: { image: string; certFile?: string; keyFile?: string }) {
  const file = resolve(configPath), root = resolve(output), { config } = await readServerConfig(file);
  if (!config.publicEndpoint || new URL(config.publicEndpoint).protocol !== 'wss:') throw new Error('deployment_requires_public_wss_endpoint');
  if (config.host !== '127.0.0.1' || config.tls || !config.devicePort || !config.clientPort)
    throw new Error('deployment_profile_requires_loopback_fixed_ports_without_internal_tls');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9./_:@-]+$/.test(options.image)) throw new Error('invalid_image_reference');
  const url = new URL(config.publicEndpoint), domain = url.hostname;
  if (!/^[a-zA-Z0-9.-]+$/.test(domain)) throw new Error('deployment_profile_requires_dns_name');
  if (/[\x00-\x1f\x7f]/.test(file)) throw new Error('invalid_deployment_config_path');
  const proxyPort = Number(url.port || '443');
  if (!proxyPort) throw new Error('deployment_proxy_requires_fixed_port');
  if (proxyPort === config.devicePort || proxyPort === config.clientPort) throw new Error('deployment_proxy_port_conflict');
  const cert = options.certFile ?? `/etc/letsencrypt/live/${domain}/fullchain.pem`;
  const key = options.keyFile ?? `/etc/letsencrypt/live/${domain}/privkey.pem`;
  if ([cert, key].some(path => !/^\/[a-zA-Z0-9_./-]+$/.test(path))) throw new Error('invalid_proxy_certificate_path');
  const info = await lstat(file);
  await mkdir(root, { mode: 0o700 });
  const compose = `services:
  server:
    image: ${options.image}
    network_mode: host
    user: "${info.uid}:${info.gid}"
    init: true
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 384m
    pids_limit: 64
    stop_grace_period: 20s
    volumes:
      - type: bind
        source: \${DOCK_CONFIG_FILE:?Set DOCK_CONFIG_FILE}
        target: /run/harness-dock/server.json
        read_only: true
        bind: {create_host_path: false}
    tmpfs: ["/tmp:size=16m,mode=1777,noexec,nosuid,nodev"]
    logging:
      driver: local
      options: {max-size: "10m", max-file: "3"}
    healthcheck:
      test: [CMD, node, -e, "fetch('http://127.0.0.1:${config.clientPort}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
`;
  const nginx = `# Review and include inside the existing nginx http block. This file is not installed automatically.
map $http_upgrade $dock_connection { default upgrade; '' close; }
map $http_x_dock_client $dock_upstream { '' 127.0.0.1:${config.devicePort}; default 127.0.0.1:${config.clientPort}; }
server {
  listen ${proxyPort} ssl;
  server_name ${domain};
  ssl_certificate ${cert};
  ssl_certificate_key ${key};
  ssl_protocols TLSv1.2 TLSv1.3;
  location = /healthz { proxy_pass http://127.0.0.1:${config.clientPort}; }
  location = / {
    proxy_pass http://$dock_upstream;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $dock_connection;
    proxy_set_header Host $host;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
  }
}
`;
  const envPath = JSON.stringify(file.replace(/\$/g, () => '$$'));
  for (const [name, content] of Object.entries({ 'compose.yaml': compose, '.env': `DOCK_CONFIG_FILE=${envPath}\n`, 'nginx.conf': nginx,
    'README.txt': `Generated only; nothing was started or reloaded.\nRequires Linux, Docker Compose, existing DNS and valid TLS files.\nTransfer server.json privately to the deployment host and set DOCK_CONFIG_FILE there.\nThe generated UID/GID must match its non-root owner on that host; update user if needed, never relax 0600.\nCheck: docker compose config --quiet\nReview nginx.conf against the existing host config and certificate paths before installation.\nStart only in your chosen maintenance window: docker compose up -d\nVerify https://${url.host}/healthz and server doctor; health alone does not prove device authentication or model execution.\nNo device or application credentials are embedded in these generated files.\n` }))
    await writeFile(join(root, name), content, { mode: 0o600, flag: 'wx' });
  return { directory: root, generatedOnly: true, endpoint: config.publicEndpoint };
}
