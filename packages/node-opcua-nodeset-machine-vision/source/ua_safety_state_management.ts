// ----- this file has been automatically generated - do not edit
import { UAObject, UAMethod } from "node-opcua-address-space-base"
import { DataType } from "node-opcua-variant"
import { UAString } from "node-opcua-basic-types"
import { UABaseDataVariable } from "node-opcua-nodeset-ua/dist/ua_base_data_variable"
/**
 * |                |                                                            |
 * |----------------|------------------------------------------------------------|
 * |namespace       |http://opcfoundation.org/UA/MachineVision                   |
 * |nodeClass       |ObjectType                                                  |
 * |typedDefinition |SafetyStateManagementType i=1009                            |
 * |isAbstract      |false                                                       |
 */
export interface UASafetyStateManagement_Base {
    reportSafetyState: UAMethod;
    visionSafetyInformation: UABaseDataVariable<UAString, DataType.String>;
    visionSafetyTriggered: UABaseDataVariable<boolean, DataType.Boolean>;
}
export interface UASafetyStateManagement extends UAObject, UASafetyStateManagement_Base {
}