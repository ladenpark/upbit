module.exports = {
  apps: [
    {
      name: 'upbit-bot',
      script: './node_modules/.bin/tsx',
      args: 'server/index.ts',
      cwd: '/home/pik0915/myproject/upbit',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3005
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/error.log',
      out_file: './logs/output.log',
      merge_logs: true
    },
    {
      name: 'cloudflared-tunnel',
      script: '/home/pik0915/bin/cloudflared',
      args: 'tunnel --protocol http2 run --token eyJhIjoiODE4NDhlMTRlYWNiNzc0ZjcxMzg3MjY4NDM1ZTY1ZWMiLCJ0IjoiMTJjZDEzYWQtYjJlMi00OTk3LTk1MTYtNmRkYzczNWE5ZmJlIiwicyI6InBsbmFxR09NRHFQTnRBaEhCaTlRdmNrajQwVVBkNGpBVitEYjd3dFhpTUU9In0=',
      instances: 1,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/tunnel_error.log',
      out_file: './logs/tunnel_output.log',
      merge_logs: true
    }
  ]
};
