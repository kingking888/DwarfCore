import {Dwarf} from "./dwarf";
import {LogicBreakpoint} from "./logic_breakpoint";
import {StalkerInfo} from "./stalker_info";
import {Utils} from "./utils";

export class LogicStalker {
    static stalkerInfoMap = {};

    static hitPreventRelease() {
        const tid = Process.getCurrentThreadId();
        const threadContext = Dwarf.threadContexts[tid];
        if (Utils.isDefined(threadContext)) {
            threadContext.preventSleep = true;
        }
    }

    static stalk(): StalkerInfo | null {
        LogicStalker.hitPreventRelease();

        const arch = Process.arch;
        const isArm64 = arch === 'arm64';

        if (!isArm64 && arch !== 'x64') {
            console.log('stalker is not supported on current arch: ' + arch);
            return null;
        }

        const tid = Process.getCurrentThreadId();

        let stalkerInfo = LogicStalker.stalkerInfoMap[tid];
        if (!Utils.isDefined(stalkerInfo)) {
            const context = Dwarf.threadContexts[tid];
            if (!Utils.isDefined(context)) {
                console.log('cant start stalker outside a valid native context');
                return null;
            }

            stalkerInfo = new StalkerInfo(tid);
            LogicStalker.stalkerInfoMap[tid] = stalkerInfo;

            const initialContextAddress = ptr(parseInt(context.pc));

            // this will maybe be replaced in the future
            // when we start stepping, the first basic block is copied into frida space and executed there
            // we need to calculate when it is executed somehow
            let retCount = 0;
            let arm64BlockCount = 0;
            let firstInstructionExec = false;
            let firstBlockCallout = false;
            let calloutHandled = false;

            if (Dwarf.DEBUG) {
                Utils.logDebug('[' + tid + '] stalk: '  + 'attaching stalker')
            }

            Stalker.follow(tid, {
                transform: function (iterator) {
                    let instruction;

                    if (Dwarf.DEBUG) {
                        Utils.logDebug('[' + tid + '] stalk: '  + 'transform begin')
                    }

                    while ((instruction = iterator.next()) !== null) {
                        iterator.keep();

                        if (instruction.groups.indexOf('jump') < 0 && instruction.groups.indexOf('call') < 0) {
                            stalkerInfo.lastBlockInstruction = {groups: instruction.groups, address: instruction.address};
                        } else {
                            stalkerInfo.lastCallJumpInstruction = {groups: instruction.groups, address: instruction.address};
                        }

                        if (!calloutHandled) {
                            if (retCount > 4) {
                                if (isArm64 && arm64BlockCount < 2) {
                                    continue;
                                }

                                if (!firstInstructionExec) {
                                    if (Dwarf.DEBUG) {
                                        Utils.logDebug('[' + tid + '] stalk: '  + 'executing first instruction',
                                            instruction.address.toString(), instruction.toString());
                                    }

                                    stalkerInfo.initialContextAddress = initialContextAddress.add(instruction.size);
                                    firstInstructionExec = true;
                                    continue;
                                }

                                if (Dwarf.DEBUG) {
                                    Utils.logDebug('[' + tid + '] stalk: '  + 'executing first basic block instructions',
                                        instruction.address.toString(), instruction.toString());
                                }

                                calloutHandled = true;
                                firstBlockCallout = true;
                                iterator.putCallout(LogicStalker.stalkerCallout);
                            }

                            if (instruction.mnemonic === 'ret') {
                                retCount++;
                            }
                        } else {
                            if (Dwarf.DEBUG) {
                                Utils.logDebug('[' + tid + '] stalk: '  + 'executing instruction',
                                    instruction.address.toString(), instruction.toString());
                            }

                            iterator.putCallout(LogicStalker.stalkerCallout);
                        }
                    }

                    if (Dwarf.DEBUG) {
                        Utils.logDebug('[' + tid + '] stalk: '  + 'transform done')
                    }

                    if (stalkerInfo.terminated) {
                        if (Dwarf.DEBUG) {
                            Utils.logDebug('[' + tid + '] stopStep: '  + 'unfollowing tid');
                        }

                        Stalker.flush();
                        Stalker.unfollow(tid);
                        Stalker.garbageCollect();

                        delete LogicStalker.stalkerInfoMap[stalkerInfo.tid];
                    }

                    if (retCount > 4 && isArm64) {
                        arm64BlockCount += 1;
                    }

                    if (firstBlockCallout) {
                        firstBlockCallout = false;
                    }
                }
            });
        }

        return stalkerInfo;
    }

    static stalkerCallout(context) {
        const tid = Process.getCurrentThreadId();
        const stalkerInfo = LogicStalker.stalkerInfoMap[tid];

        if (!Utils.isDefined(stalkerInfo) || stalkerInfo.terminated) {
            return;
        }

        let pc = context.pc;
        const insn = Instruction.parse(pc);

        if (Dwarf.DEBUG) {
            Utils.logDebug('[' + tid + '] stalkerCallout: ' + 'running callout', insn.address, insn.toString());
        }

        if (!stalkerInfo.didFistJumpOut) {
            pc = stalkerInfo.initialContextAddress;

            const lastInt = parseInt(stalkerInfo.lastContextAddress);
            if (lastInt > 0) {
                const pcInt = parseInt(context.pc);

                if (pcInt < lastInt || pcInt > lastInt + insn.size) {
                    pc = context.pc;
                    stalkerInfo.didFistJumpOut = true;
                }
            }
        }

        let shouldBreak = false;

        if (stalkerInfo.currentMode !== null) {
            if (typeof stalkerInfo.currentMode === 'function') {
                shouldBreak = false;

                const that = {
                    context: context,
                    instruction: insn,
                    stop: function () {
                        stalkerInfo.terminated = true;
                    }
                };

                stalkerInfo.currentMode.apply(that);
            } else if (stalkerInfo.lastContextAddress !== null &&
                stalkerInfo.lastCallJumpInstruction !== null) {
                if (Dwarf.DEBUG) {
                    Utils.logDebug('[' + tid + '] stalkerCallout: ' + 'using mode ->', stalkerInfo.currentMode);
                }
                // call and jumps doesn't receive callout
                const isAddressBeforeJumpOrCall = parseInt(context.pc) === parseInt(
                    stalkerInfo.lastBlockInstruction.address);

                if (isAddressBeforeJumpOrCall) {
                    if (stalkerInfo.currentMode === 'call') {
                        if (stalkerInfo.lastCallJumpInstruction.groups.indexOf('call') >= 0) {
                            shouldBreak = true;
                        }
                    } else if (stalkerInfo.currentMode === 'block') {
                        if (stalkerInfo.lastCallJumpInstruction.groups.indexOf('jump') >= 0) {
                            shouldBreak = true;
                        }
                    }
                }
            }
        } else {
            shouldBreak = true;
        }

        if (shouldBreak) {
            stalkerInfo.context = context;
            stalkerInfo.lastContextAddress = context.pc;

            LogicBreakpoint.breakpoint(LogicBreakpoint.REASON_STEP, pc, stalkerInfo.context, null);

            if (Dwarf.DEBUG) {
                Utils.logDebug('[' + tid + '] callOut: ' + 'post onHook');
            }
        }

        if (!stalkerInfo.didFistJumpOut) {
            stalkerInfo.initialContextAddress = stalkerInfo.initialContextAddress.add(insn.size);
        }
    }
}