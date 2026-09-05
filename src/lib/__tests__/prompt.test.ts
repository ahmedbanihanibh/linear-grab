import { describe, expect, it } from 'vitest';
import { buildAgentInstructions, DEFAULT_AGENT_INSTRUCTIONS } from '../ai/prompt';

const SETTINGS = {
  testUsername: 'demo@app.com',
  testPassword: 'hunter2',
  githubAssetsRepo: 'owner/assets',
};

describe('buildAgentInstructions evidence modes', () => {
  it('video (default) demands a recording, test account, and demo DoD items', () => {
    const out = buildAgentInstructions(SETTINGS);
    expect(out).toContain('RECORD a demo video or GIF');
    expect(out).toContain('demo@app.com');
    expect(out).toContain('Demo media hosting');
    expect(out).toContain('Demo media captured');
    expect(out).toContain('Demo media attached to the Linear ISSUE');
  });

  it('spec swaps the recording for spec-crawler 1:1 evidence', () => {
    const out = buildAgentInstructions(SETTINGS, { evidence: 'spec' });
    expect(out).not.toContain('RECORD a demo video');
    expect(out).toContain('spec-crawler MCP');
    expect(out).toContain('capture_component');
    expect(out).toContain('spec-bundle/frames');
    // still hands-on: keeps the test account, drops the video hosting/DoD
    expect(out).toContain('demo@app.com');
    expect(out).not.toContain('Demo media hosting');
    expect(out).not.toContain('Demo media captured');
    expect(out).toContain('1:1 evidence produced with the spec-crawler MCP');
  });

  it('none drops evidence demands and credentials entirely', () => {
    const out = buildAgentInstructions(SETTINGS, { evidence: 'none' });
    expect(out).not.toContain('RECORD a demo video');
    expect(out).not.toContain('spec-crawler');
    expect(out).not.toContain('demo@app.com');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('Demo media');
    // testing itself stays mandatory
    expect(out).toContain('TEST your change hands-on');
    expect(out).toContain('PR opened and linked here');
  });

  it('appends an explicit override when a custom template is set', () => {
    const custom = { ...SETTINGS, issueTemplate: 'Do the thing my way.' };
    const spec = buildAgentInstructions(custom, { evidence: 'spec' });
    expect(spec).toContain('Do the thing my way.');
    expect(spec).toContain('Evidence override for THIS issue: no demo video.');
    const video = buildAgentInstructions(custom, { evidence: 'video' });
    expect(video).not.toContain('Evidence override');
  });

  it('exported default instructions are the video variant', () => {
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain('RECORD a demo video or GIF');
  });
});
