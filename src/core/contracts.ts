import type { ContractInterface } from '@orkestrel/contract'
import type {
	PhaseDefinition,
	PhaseUpdate,
	TaskDefinition,
	TaskUpdate,
	WorkflowDefinition,
} from './types.js'
import { createContract } from '@orkestrel/contract'
import {
	phaseShape,
	phaseUpdateShape,
	taskDefinitionShape,
	taskUpdateShape,
	workflowShape,
} from './shapers.js'

/**
 * Holds the compiled {@link WorkflowDefinition} contract every definition-driven mint enters through.
 *
 * @example
 * ```ts
 * import { workflowContract } from '@orkestrel/workflow'
 *
 * workflowContract.is({ id: 'release', name: 'Release', phases: [] }) // true
 * workflowContract.audit({ id: 'release', name: 'Release', phases: [], bails: true })
 * // [{ reason: 'extra', path: ['bails'] }]
 * ```
 */
export const workflowContract: ContractInterface<WorkflowDefinition> = createContract(workflowShape)

/**
 * Holds the compiled {@link PhaseDefinition} contract a live `add` on a workflow enters through.
 *
 * @example
 * ```ts
 * import { phaseContract } from '@orkestrel/workflow'
 *
 * phaseContract.is({ id: 'build', name: 'Build', tasks: [] }) // true
 * phaseContract.is({ id: 'build', name: 'Build', tasks: [], concurrency: 0 }) // false
 * ```
 */
export const phaseContract: ContractInterface<PhaseDefinition> = createContract(phaseShape)

/**
 * Holds the compiled {@link TaskDefinition} contract a live `add` on a phase enters through.
 *
 * @example
 * ```ts
 * import { taskDefinitionContract } from '@orkestrel/workflow'
 *
 * taskDefinitionContract.is({ id: 'compile', name: 'Compile', timeout: 5_000 }) // true
 * taskDefinitionContract.is({ id: 'compile', name: 'Compile', timeout: 0 }) // false
 * ```
 */
export const taskDefinitionContract: ContractInterface<TaskDefinition> =
	createContract(taskDefinitionShape)

/**
 * Holds the compiled {@link TaskUpdate} contract a task manager's `update` validates a patch with.
 *
 * @example
 * ```ts
 * import { taskUpdateContract } from '@orkestrel/workflow'
 *
 * taskUpdateContract.is({ name: 'Compile again' }) // true
 * taskUpdateContract.is({ name: '' }) // false
 * ```
 */
export const taskUpdateContract: ContractInterface<TaskUpdate> = createContract(taskUpdateShape)

/**
 * Holds the compiled {@link PhaseUpdate} contract a phase manager's `update` validates a patch with.
 *
 * @example
 * ```ts
 * import { phaseUpdateContract } from '@orkestrel/workflow'
 *
 * phaseUpdateContract.is({ concurrency: 4 }) // true
 * phaseUpdateContract.is({ concurrency: 0 }) // false
 * ```
 */
export const phaseUpdateContract: ContractInterface<PhaseUpdate> = createContract(phaseUpdateShape)
