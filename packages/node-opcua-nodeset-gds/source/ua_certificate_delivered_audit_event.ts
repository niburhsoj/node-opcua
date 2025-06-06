// ----- this file has been automatically generated - do not edit
import { UAProperty } from "node-opcua-address-space-base"
import { DataType } from "node-opcua-variant"
import { NodeId } from "node-opcua-nodeid"
import { UAAuditUpdateMethodEvent, UAAuditUpdateMethodEvent_Base } from "node-opcua-nodeset-ua/dist/ua_audit_update_method_event"
/**
 * |                |                                                            |
 * |----------------|------------------------------------------------------------|
 * |namespace       |http://opcfoundation.org/UA/GDS/                            |
 * |nodeClass       |ObjectType                                                  |
 * |typedDefinition |CertificateDeliveredAuditEventType i=109                    |
 * |isAbstract      |true                                                        |
 */
export interface UACertificateDeliveredAuditEvent_Base extends UAAuditUpdateMethodEvent_Base {
    certificateGroup: UAProperty<NodeId, DataType.NodeId>;
    certificateType: UAProperty<NodeId, DataType.NodeId>;
}
export interface UACertificateDeliveredAuditEvent extends UAAuditUpdateMethodEvent, UACertificateDeliveredAuditEvent_Base {
}