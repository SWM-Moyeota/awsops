import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_DOCS_URL: process.env.NEXT_PUBLIC_DOCS_URL || 'https://whchoi98.github.io/awsops',
  },
  webpack: (config) => {
    // CLAUDE.md docs live alongside code under src/; dynamic imports like
    // `@/lib/collectors/${route}` make webpack scan the whole directory,
    // so .md files must be treated as plain text, not parsed as modules.
    config.module.rules.push({ test: /\.md$/, type: 'asset/source' });
    // fossflow requires the whole @mui/icons-material barrel (~10,600 modules).
    // `$` = exact match only, so deep imports (@mui/icons-material/Add) still resolve normally.
    config.resolve.alias['@mui/icons-material$'] = path.resolve(__dirname, 'src/lib/fossflow/mui-icons-shim.js');
    return config;
  },
};

export default nextConfig;
