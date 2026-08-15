#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createStage1Server } from '../stage1/server.js';

const server = createStage1Server();
await server.connect(new StdioServerTransport());
