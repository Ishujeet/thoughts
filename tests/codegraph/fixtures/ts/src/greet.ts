// @ts-nocheck — fixture parsed as source text by the codegraph tests, never compiled
import { pad } from './pad';
import fs from 'node:fs';
import { Client } from '@acme/payments-api';

export function greet(name: string): string {
  return pad('hello ' + name);
}

export class Widget {
  render(): string {
    return greet('x');
  }
}

export interface Shape {
  area(): number;
}

export type Alias = string;

export const LIMIT = 3;

export function unused(): string {
  return fs.existsSync('x') ? Client.call() : 'no';
}
