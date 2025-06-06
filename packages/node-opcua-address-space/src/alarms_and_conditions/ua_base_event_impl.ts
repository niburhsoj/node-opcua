/**
 * @module node-opcua-address-space.AlarmsAndConditions
 */
import { assert } from "node-opcua-assert";
import { NodeId } from "node-opcua-nodeid";
import { DataType, Variant } from "node-opcua-variant";
import { BaseNode } from "node-opcua-address-space-base";
import { UABaseEvent_Base, UABaseEvent } from "node-opcua-nodeset-ua";

import { UAObjectImpl } from "../ua_object_impl";
import { UABaseEventHelper } from "../../source/interfaces/alarms_and_conditions/ua_condition_ex";

export interface UABaseEventEx extends UABaseEvent_Base, UABaseEventHelper {
    /** empty interface */
}
export declare interface UABaseEventImpl extends UABaseEventEx {
    /** empty interface */
}

/**
 * @internal
 */
export class UABaseEventImpl extends UAObjectImpl implements UABaseEventEx {
    /**
     */
    public setSourceName(name: string): void {
        assert(typeof name === "string");
        this.sourceName.setValueFromSource(
            new Variant({
                dataType: DataType.String,
                value: name
            })
        );
    }

    /**
     */
    public setSourceNode(node: NodeId | BaseNode): void {
        this.sourceNode.setValueFromSource(
            new Variant({
                dataType: DataType.NodeId,
                value: (node as any).nodeId ? (node as any).nodeId : node
            })
        );
    }
}
