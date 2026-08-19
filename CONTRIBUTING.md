# Contributing to Muster

Thank you for your interest in contributing to Muster!

Muster supports Node.js 22 LTS and newer maintained Node.js lines. Node 18 and
Node 20 are end-of-life and are not supported for development or release
verification. See [docs/runtime-support.md](docs/runtime-support.md) before
updating the runtime floor or CI matrix.

## Development Workflow

1. **Fork & Clone**:
   ```bash
   git clone https://github.com/your-org/muster.git
   cd muster
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Run Development Server**:
   ```bash
   npm run dev
   ```

4. **Run Verification & Tests**:
   ```bash
   npm run build
   npm test
   ```

## Agent Collaboration Guidelines
All pull requests, whether authored by human developers or AI coding assistants (e.g., Claude, Cursor, Antigravity), must adhere to the **Agent Operating Protocol**:
- Ensure all domain service changes return async Promises.
- Keep SQL keywords properly escaped (`"column"`).
- Include Vitest unit/integration tests for new API routes or service methods.
