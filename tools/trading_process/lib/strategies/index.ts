import { bbBreakoutStrategy } from './bb_breakout.js';
import { macdCrossStrategy } from './macd_cross.js';
import { rsiStrategy } from './rsi.js';
import { smaCrossStrategy } from './sma_cross.js';
import type { Strategy, StrategyRegistry, StrategyType } from './types.js';

const registry: StrategyRegistry = new Map<StrategyType, Strategy>();

registry.set('sma_cross', smaCrossStrategy);
registry.set('rsi', rsiStrategy);
registry.set('macd_cross', macdCrossStrategy);
registry.set('bb_breakout', bbBreakoutStrategy);

export function getStrategy(type: StrategyType): Strategy | undefined {
	return registry.get(type);
}

export function getAvailableStrategies(): StrategyType[] {
	return Array.from(registry.keys());
}

export function registerStrategy(strategy: Strategy): void {
	registry.set(strategy.type, strategy);
}

export function getStrategyDefaults(type: StrategyType): Record<string, number> | undefined {
	const strategy = registry.get(type);
	return strategy?.defaultParams;
}

export * from './types.js';
export { bbBreakoutStrategy, macdCrossStrategy, rsiStrategy, smaCrossStrategy };
