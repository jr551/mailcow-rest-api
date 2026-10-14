'use strict';

const VALID_LEAF_TYPES = [
    'envelope-to-is',
    'header-contains',
    'header-is',
    'from-contains',
    'to-contains',
    'subject-contains'
];

function isGroupCondition(condition) {
    return condition && typeof condition === 'object' && Array.isArray(condition.conditions);
}

function isLeafCondition(condition) {
    return condition && typeof condition === 'object' && typeof condition.type === 'string';
}

function validateLeafCondition(condition, path = 'condition') {
    if (!isLeafCondition(condition)) {
        throw new Error(`${path} must include a type`);
    }
    if (!VALID_LEAF_TYPES.includes(condition.type)) {
        throw new Error(`Invalid condition type at ${path}. Must be one of: ${VALID_LEAF_TYPES.join(', ')}`);
    }
    if (condition.type.startsWith('header-') && !condition.header) {
        throw new Error(`Header name is required for header conditions at ${path}`);
    }
    if (!condition.value || typeof condition.value !== 'string') {
        throw new Error(`Condition value is required at ${path}`);
    }
    if (condition.not !== undefined && typeof condition.not !== 'boolean') {
        throw new Error(`Condition "not" must be a boolean at ${path}`);
    }
}

function validateRuleCondition(condition) {
    if (!condition || typeof condition !== 'object') {
        throw new Error('Rule condition is required');
    }
    if (isGroupCondition(condition)) {
        if (condition.match !== 'all' && condition.match !== 'any') {
            throw new Error('Compound condition "match" must be "all" or "any"');
        }
        if (!condition.conditions.length) {
            throw new Error('Compound condition needs at least one sub-condition');
        }
        if (condition.conditions.length > 20) {
            throw new Error('Compound condition supports at most 20 sub-conditions');
        }
        for (let i = 0; i < condition.conditions.length; i++) {
            if (isGroupCondition(condition.conditions[i])) {
                throw new Error('Nested compound conditions are not supported');
            }
            validateLeafCondition(condition.conditions[i], `condition.conditions[${i}]`);
        }
        return;
    }
    validateLeafCondition(condition);
}

function ruleUsesEnvelope(condition) {
    if (isGroupCondition(condition)) {
        return condition.conditions.some((c) => c.type === 'envelope-to-is');
    }
    return condition.type === 'envelope-to-is';
}

module.exports = {
    VALID_LEAF_TYPES,
    isGroupCondition,
    isLeafCondition,
    validateRuleCondition,
    ruleUsesEnvelope
};
