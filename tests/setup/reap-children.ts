/**
 * Vitest setup: media children (FFmpeg, capture stand-ins) started through the runner never
 * outlive the test file that started them, even when a test failed or timed out while one was
 * still running. A crash of the worker itself is covered by their parent-death signal.
 */
import { afterAll } from 'vitest';
import { killAllChildren } from '../../src/utility/media/child-processes';

afterAll(() => {
  killAllChildren();
});
