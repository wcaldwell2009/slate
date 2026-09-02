// Headless Claude Code session (Claude Agent SDK) with in-process browser MCP tools.
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as chrome from './chrome.js';
import * as docs from './docs.js';

const SYSTEM_PROMPT = `You are Browser Copilot, a helpful assistant that reads web pages in the user's own Chrome browser and fills in information for them. You are talking to the user in a chat UI where they have selected one of their browser tabs; each of their messages is prefixed with the currently selected tab.

Each user message automatically includes a fresh snapshot of the selected tab: its URL, title, visible text, and every interactive element (inputs, selects, buttons, links) with an elementId, label, and current value. Work from that snapshot directly — do NOT call read_page for information the snapshot already has.

You control the browser ONLY through your browser tools:
- fill_many / fill_field / click_element / press_key: act on elementIds from the snapshot (or the most recent read_page). When you have several fields to fill, ALWAYS use one fill_many call with all of them — it is much faster than filling one field at a time.
- read_page: re-read the page ONLY when it changed after the snapshot — you clicked something, navigated, or a fill result looked wrong. elementIds reset when a page reloads.
- screenshot: look at the page visually when the structured read is ambiguous (layouts, images, captchas, unclear state).
- navigate, list_tabs, switch_tab: change pages or move to another tab when needed.

Working style:
- Be fast. For routine form filling, go straight to one fill_many call, then answer.
- fill_many/fill_field return the resulting value of each field — that IS your verification. Do not re-read the page just to double-check; only investigate if a returned value looks wrong.
- Only use information the user gave you, that is in this conversation, or that is visible in the browser. NEVER invent personal data (names, addresses, card numbers, answers). If a needed value is missing, fill what you can, then ask the user for the rest.
- Filling fields is always fine. But do NOT click buttons that submit a form, send a message, place an order, or otherwise commit an action unless the user explicitly asked you to — by default, fill everything in and leave the final click to the user or ask first.
- Keep replies short and conversational; this is a chat, not a report. Don't repeat the page content back at length.

Documents:
- You can make real files for the user with save_document / list_documents / read_document. They land in the "Browser Copilot" folder inside their Documents, and show up on the Documents tab of this app. Use save_document whenever they ask you to write something up, save something, or make a file. Pick a sensible file name with an extension (.md, .txt, .csv, .html).
- To change an existing document, read_document it first, then save_document the full new version under the same name.
- When the user attaches a file to a message you are given its path — open it with the Read tool (it handles images and PDFs as well as text).`;

class MessageQueue {
  queue = [];
  waiters = [];
  done = false;

  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.queue.length === 0 && !this.done) {
        await new Promise((resolve) => this.waiters.push(resolve));
      }
      if (this.queue.length === 0 && this.done) return;
      yield this.queue.shift();
    }
  }

  push(item) {
    this.queue.push(item);
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  finish() {
    this.done = true;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

export class ChatSession {
  constructor(onEvent, model) {
    this.onEvent = onEvent; // (event) => void — forwarded to the web UI
    this.model = model || process.env.COPILOT_MODEL || 'sonnet';
    this.currentTabId = null;
    this.queue = new MessageQueue();
    this.q = null;
    this.busy = false;
  }

  // ---- browser tools, bound to this session's selected tab -----------------

  #requireTab() {
    if (!this.currentTabId) {
      throw new Error('No browser tab is selected. Ask the user to pick a tab in the dropdown, or use list_tabs + switch_tab.');
    }
    return this.currentTabId;
  }

  #buildMcpServer() {
    const self = this;

    // Wrap a handler: emit UI events, convert results/errors to MCP content.
    const run = (name, fn) => async (args) => {
      self.onEvent({ type: 'tool', name, input: args });
      try {
        const result = await fn(args);
        self.onEvent({ type: 'tool_done', name, ok: true });
        if (result && result.__image) {
          return { content: [{ type: 'image', data: result.__image, mimeType: 'image/jpeg' }] };
        }
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
      } catch (err) {
        self.onEvent({ type: 'tool_done', name, ok: false, error: String(err.message || err) });
        return { content: [{ type: 'text', text: `Error: ${err.message || err}` }], isError: true };
      }
    };

    return createSdkMcpServer({
      name: 'browser',
      version: '1.0.0',
      tools: [
        tool(
          'read_page',
          "Read the currently selected browser tab: URL, title, visible text, and all interactive elements (each with an elementId to use with fill_field/click_element). Call this first, and again whenever the page changes or reloads.",
          {},
          run('read_page', async () => chrome.readPage(self.#requireTab()))
        ),
        tool(
          'fill_field',
          'Fill one form field in the selected tab. Works on text inputs, textareas, selects (pass the option text or value), checkboxes/radios (pass "true"/"false"), and contenteditable boxes. Use an elementId from the latest read_page.',
          {
            elementId: z.string().describe('The ccId of the element, from read_page'),
            value: z.string().describe('The value to enter (for selects: option text; for checkboxes: "true"/"false")'),
          },
          run('fill_field', async ({ elementId, value }) => chrome.fillField(self.#requireTab(), elementId, value))
        ),
        tool(
          'fill_many',
          'Fill several form fields in the selected tab in one call — much faster than repeated fill_field. Same value rules as fill_field. Fields are filled in order; a failure on one field does not stop the rest.',
          {
            fields: z
              .array(
                z.object({
                  elementId: z.string().describe('The ccId of the element, from read_page'),
                  value: z.string().describe('The value to enter'),
                })
              )
              .min(1)
              .describe('All fields to fill, in order'),
          },
          run('fill_many', async ({ fields }) => {
            const results = [];
            for (const { elementId, value } of fields) {
              try {
                results.push({ elementId, ...(await chrome.fillField(self.#requireTab(), elementId, value)) });
              } catch (err) {
                results.push({ elementId, ok: false, error: String(err.message || err) });
              }
            }
            return results;
          })
        ),
        tool(
          'click_element',
          'Click an element (button, link, checkbox...) in the selected tab, by elementId from the latest read_page. Do not click submit/send/purchase buttons unless the user explicitly asked.',
          { elementId: z.string().describe('The ccId of the element, from read_page') },
          run('click_element', async ({ elementId }) => chrome.clickElement(self.#requireTab(), elementId))
        ),
        tool(
          'press_key',
          'Press a key in the selected tab (goes to the currently focused element). Useful for Enter to submit a search box.',
          { key: z.enum(['Enter', 'Tab', 'Escape']).describe('Key to press') },
          run('press_key', async ({ key }) => chrome.pressKey(self.#requireTab(), key))
        ),
        tool(
          'screenshot',
          'Take a screenshot of the selected tab (brings it to the foreground). Use when the structured read_page output is not enough to understand the page.',
          {},
          run('screenshot', async () => ({ __image: await chrome.screenshot(self.#requireTab()) }))
        ),
        tool(
          'navigate',
          'Navigate the selected tab to a URL.',
          { url: z.string().describe('Absolute URL, e.g. https://example.com') },
          run('navigate', async ({ url }) => chrome.navigate(self.#requireTab(), url))
        ),
        tool(
          'list_tabs',
          "List the user's open browser tabs (id, title, url).",
          {},
          run('list_tabs', async () => chrome.listTabs())
        ),
        tool(
          'switch_tab',
          'Change which tab is selected for all other tools, by tab id from list_tabs.',
          { tabId: z.string().describe('Tab id from list_tabs') },
          run('switch_tab', async ({ tabId }) => {
            const tabs = await chrome.listTabs();
            const tab = tabs.find((t) => t.id === tabId);
            if (!tab) throw new Error('No tab with that id — call list_tabs for current ids.');
            self.currentTabId = tabId;
            self.onEvent({ type: 'tab_switched', tabId, title: tab.title });
            return { ok: true, nowSelected: { title: tab.title, url: tab.url } };
          })
        ),
      ],
    });
  }

  // Documents: the ONLY writing the session can do. File names are flattened
  // to a safe basename in docs.js, so everything lands inside the Browser
  // Copilot folder whatever a page or a reply asks for.
  #buildDocsServer() {
    const self = this;
    const run = (name, fn) => async (args) => {
      self.onEvent({ type: 'tool', name, input: args });
      try {
        const result = await fn(args);
        self.onEvent({ type: 'tool_done', name, ok: true });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        self.onEvent({ type: 'tool_done', name, ok: false, error: String(err.message || err) });
        return { content: [{ type: 'text', text: `Error: ${err.message || err}` }], isError: true };
      }
    };
    return createSdkMcpServer({
      name: 'docs',
      version: '1.0.0',
      tools: [
        tool(
          'save_document',
          "Create or fully overwrite a document in the user's Browser Copilot folder. Pass the COMPLETE content — this replaces the whole file. The user sees it on the Documents tab.",
          {
            name: z.string().describe('File name with extension, e.g. "meeting notes.md"'),
            content: z.string().describe('The complete file content'),
          },
          run('save_document', async ({ name, content }) => docs.saveDoc(name, content))
        ),
        tool(
          'list_documents',
          'List the documents saved so far (name, size, last modified).',
          {},
          run('list_documents', async () => docs.listDocs())
        ),
        tool(
          'read_document',
          'Read one saved document back, by name from list_documents.',
          { name: z.string().describe('The file name, from list_documents') },
          run('read_document', async ({ name }) => docs.readDoc(name))
        ),
      ],
    });
  }

  // ---- lifecycle -----------------------------------------------------------

  start() {
    this.q = query({
      prompt: this.queue,
      options: {
        model: this.model,
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: { browser: this.#buildMcpServer(), docs: this.#buildDocsServer() },
        // Read is allowed so attached files (text, images, PDFs) can be
        // looked at — the same tool Slate's own hidden helpers use. Writing
        // stays locked to the sandboxed document tools above.
        allowedTools: ['mcp__browser__*', 'mcp__docs__*', 'Read'],
        disallowedTools: [
          'Bash', 'BashOutput', 'KillShell', 'Edit', 'Write', 'NotebookEdit',
          'Glob', 'Grep', 'Task', 'WebFetch', 'WebSearch', 'TodoWrite',
        ],
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        cwd: process.cwd(),
      },
    });
    this.#consume().catch((err) => {
      this.onEvent({ type: 'error', message: `Claude session crashed: ${err.message || err}` });
    });
  }

  async #consume() {
    for await (const message of this.q) {
      switch (message.type) {
        case 'system':
          if (message.subtype === 'init') {
            this.onEvent({ type: 'ready', sessionId: message.session_id, model: message.model });
          }
          break;

        case 'stream_event': {
          // Shape differs across SDK versions: singular `event` or `events` array.
          const events = message.event ? [message.event] : Array.isArray(message.events) ? message.events : [];
          for (const ev of events) {
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
              this.onEvent({ type: 'delta', text: ev.delta.text });
            }
          }
          break;
        }

        case 'assistant':
          for (const block of message.message?.content || []) {
            if (block.type === 'text' && block.text?.trim()) {
              // Authoritative full text — the UI replaces its streamed buffer with this.
              this.onEvent({ type: 'text', text: block.text });
            }
            // MCP tool_use events are emitted from the tool wrapper instead
            // (they include execution status). Read is a built-in with no
            // wrapper, so surface it here or attachments open invisibly.
            if (block.type === 'tool_use' && block.name === 'Read') {
              this.onEvent({ type: 'tool', name: 'Read', input: block.input });
            }
          }
          break;

        case 'result':
          this.busy = false;
          this.onEvent({
            type: 'turn_done',
            ok: message.subtype === 'success',
            subtype: message.subtype,
            costUsd: message.total_cost_usd,
          });
          break;
      }
    }
  }

  sendMessage(text, tabId, tabLabel, snapshot, attachments = []) {
    if (tabId) this.currentTabId = tabId;
    let header = tabLabel ? `[Selected tab: ${tabLabel}]\n` : '';
    if (snapshot) {
      header += `[Page snapshot — use these elementIds directly, no need to call read_page:\n${JSON.stringify(snapshot)}]\n`;
    }
    for (const p of attachments) {
      header += `[The user attached a file: ${p} — open it with the Read tool.]\n`;
    }
    if (header) header += '\n';
    this.busy = true;
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: header + text },
      parent_tool_use_id: null,
      session_id: '',
    });
  }

  async interrupt() {
    try {
      if (this.q && typeof this.q.interrupt === 'function') {
        await this.q.interrupt();
        this.busy = false;
        return true;
      }
    } catch {
      // ignore — interrupt is best-effort
    }
    return false;
  }

  dispose() {
    this.queue.finish();
    this.interrupt();
  }
}
