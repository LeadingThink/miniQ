-- Child agents no longer accept model-step budgets. Remove the retired field
-- from persisted requests so they deserialize under the same strict contract
-- as new requests, without changing histories, results or other task metadata.
UPDATE agent_tasks
SET state_json = json_remove(state_json, '$.request.maxTurns')
WHERE json_type(state_json, '$.request.maxTurns') IS NOT NULL;
