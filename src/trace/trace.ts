import binsearch from 'array-binsearch';
import Bounds from './bounds';
import CpuProfile from './cpuprofile';
import Process from './process';
import Thread from './thread';
import {
  ARGS,
  ICpuProfile,
  ICpuProfileEvent,
  ICpuProfileNode,
  IProfileChunkEvent,
  IProfileEvent,
  IProfileNode,
  ITraceEvent,
  PROCESS_NAME,
  TRACE_EVENT_PHASE,
} from './trace_event';
import traceEventComparator from './trace_event_comparator';

interface IPartialCpuProfile extends ICpuProfile {
  nodes: Array<ICpuProfileNode & IProfileNode>;
}

export default class Trace {
  processes: Process[] = [];
  mainProcess?: Process;
  bounds: Bounds = new Bounds();
  events: ITraceEvent[] = [];
  browserProcess: Process | null = null;
  gpuProcess: Process | null = null;
  rendererProcesses: Process[] = [];
  numberOfProcessors?: number;

  lastTracingStartedInPageEvent?: ITraceEvent;

  private _cpuProfile?: ICpuProfile;
  private parents = new Map<ITraceEvent, ITraceEvent>();
  private stack: ITraceEvent[] = [];

  private profileMap = new Map<
    string,
    {
      pid: number;
      tid: number;
      cpuProfile: IPartialCpuProfile;
    }
  >();

  cpuProfile(min: number, max: number): CpuProfile {
    const { _cpuProfile } = this;
    if (_cpuProfile === undefined) {
      throw new Error('trace is missing CpuProfile');
    }
    return new CpuProfile(_cpuProfile, min, max);
  }

  process(pid: number): Process {
    let process = this.findProcess(pid);
    if (process === undefined) {
      process = new Process(pid);
      this.processes.push(process);
    }
    return process;
  }

  thread(pid: number, tid: number): Thread {
    return this.process(pid).thread(tid);
  }

  addEvents(events: ITraceEvent[]) {
    for (const event of events) {
      this.addEvent(event);
    }
  }

  buildModel() {
    const { events } = this;
    if (this.stack.length > 0) {
      /* tslint:disable:no-console */
      console.error('trace has incomplete B phase events');
      this.stack.length = 0;
    }
    for (const event of events) {
      this.associateParent(event);
      const process = this.process(event.pid);

      process.addEvent(event);

      if (
        event.ph === TRACE_EVENT_PHASE.INSTANT &&
        event.cat === 'disabled-by-default-devtools.timeline'
      ) {
        if (event.name === 'CpuProfile') {
          this._cpuProfile = (event as ICpuProfileEvent).args.data.cpuProfile;
        } else if (event.name === 'TracingStartedInPage') {
          this.lastTracingStartedInPageEvent = event;
        }
      } else if (event.ph === TRACE_EVENT_PHASE.SAMPLE) {
        if (event.name === 'Profile') {
          const profile = event as IProfileEvent;
          this.profileMap.set(profile.id, {
            pid: profile.pid,
            tid: profile.tid,
            cpuProfile: {
              startTime: profile.args.data.startTime,
              endTime: 0,
              duration: 0,
              nodes: [] as Array<ICpuProfileNode & IProfileNode>,
              samples: [] as number[],
              timeDeltas: [] as number[],
            },
          });
        }
        if (event.name === 'ProfileChunk') {
          const profileChunk = event as IProfileChunkEvent;
          const profileEntry = this.profileMap.get(profileChunk.id)!;
          if (profileChunk.args.data.cpuProfile.nodes) {
            profileChunk.args.data.cpuProfile.nodes.forEach(node => {
              profileEntry.cpuProfile.nodes.push(
                Object.assign(node, {
                  sampleCount: 0,
                  min: 0,
                  max: 0,
                  total: 0,
                  self: 0,
                }),
              );
            });
          }
          profileEntry.cpuProfile.samples.push(...profileChunk.args.data.cpuProfile.samples);
          profileEntry.cpuProfile.timeDeltas.push(...profileChunk.args.data.timeDeltas);
        }
      }
    }

    // determine main process
    if (this.lastTracingStartedInPageEvent) {
      // if this was recorded with the Performance tab, this should be the main process
      this.mainProcess = this.process(this.lastTracingStartedInPageEvent.pid);
    } else {
      // fallback to Renderer process with most events
      this.mainProcess = this.processes
        .filter(p => p.name === PROCESS_NAME.RENDERER)
        .reduce((a, b) => (b.events.length > a.events.length ? b : a));
    }
    for (const profileEntry of this.profileMap.values()) {
      if (
        profileEntry.pid === this.mainProcess.id &&
        profileEntry.tid === this.mainProcess.mainThread!.id
      ) {
        this._cpuProfile = profileEntry.cpuProfile;
        const { nodes } = profileEntry.cpuProfile;
        const nodeMap = new Map<number, typeof nodes[0]>();
        nodes.forEach(node => nodeMap.set(node.id, node));
        nodes.forEach(node => {
          if (node.parent !== undefined) {
            const parent = nodeMap.get(node.parent)!;
            if (parent.children) {
              parent.children.push(node.id);
            } else {
              parent.children = [node.id];
            }
          }
        });
        break;
      }
    }
  }

  getParent(event: ITraceEvent) {
    this.parents.get(event);
  }

  private associateParent(event: ITraceEvent) {
    if (event.ph !== TRACE_EVENT_PHASE.COMPLETE) {
      return;
    }
    const { stack, parents } = this;
    const { ts, pid, tid } = event;
    for (let i = stack.length - 1; i >= 0; i--) {
      const parent = stack[i];
      if (ts < parent.ts + parent.dur!) {
        if (parent.pid === pid && parent.tid === tid) {
          parents.set(event, parent);
          break;
        }
      } else {
        stack.splice(i, 1);
      }
    }
    stack.push(event);
  }

  private addEvent(event: ITraceEvent) {
    if (event.ph === TRACE_EVENT_PHASE.END) {
      this.endEvent(event);
      return;
    }
    const events = this.events;
    let index = binsearch(events, event, traceEventComparator);
    if (index < 0) {
      /* tslint:disable:no-bitwise */
      index = ~index;
    } else {
      // insert just after if ts order matched
      index++;
    }
    events.splice(index, 0, event);
    if (event.ph === TRACE_EVENT_PHASE.METADATA) {
      this.addMetadata(event);
      return;
    }
    if (event.ph === TRACE_EVENT_PHASE.BEGIN) {
      this.stack.push(event);
    }
    this.bounds.addEvent(event);
  }

  private findProcess(pid: number): Process | undefined {
    for (const process of this.processes) {
      if (process.id === pid) {
        return process;
      }
    }
    return;
  }

  private endEvent(end: ITraceEvent) {
    const { stack } = this;
    for (let i = stack.length - 1; i >= 0; i--) {
      const begin = stack[i];
      if (
        begin.name === end.name &&
        begin.cat === end.cat &&
        begin.tid === end.tid &&
        begin.pid === end.pid
      ) {
        stack.splice(i, 1);
        return this.completeEvent(begin, end);
      }
    }
    throw new Error('could not find matching B phase for E phase event');
  }

  private completeEvent(begin: ITraceEvent, end: ITraceEvent) {
    let args: { [key: string]: any } | ARGS.STRIPPED = ARGS.STRIPPED;
    if (typeof begin.args === 'object' && begin.args !== null) {
      args = Object.assign({}, begin.args);
    }
    if (typeof end.args === 'object' && end.args !== null) {
      args = Object.assign(args === undefined ? {} : args, end.args);
    }

    const complete: ITraceEvent = {
      args,
      cat: begin.cat,
      dur: end.ts - begin.ts,
      name: begin.name,
      ph: TRACE_EVENT_PHASE.COMPLETE,
      pid: begin.pid,
      tdur: end.tts! - begin.tts!,
      tid: begin.tid,
      ts: begin.ts,
      tts: begin.tts,
    };
    const { events } = this;
    const index = binsearch(events, begin, traceEventComparator);
    events[index] = complete;
  }

  private addMetadata(event: ITraceEvent) {
    const { pid, tid } = event;
    if (event.args === ARGS.STRIPPED) {
      return;
    }
    switch (event.name) {
      case 'num_cpus':
        this.numberOfProcessors = event.args.number;
        break;
      case 'process_name':
        const processName: string = event.args.name;
        const process = this.process(pid);
        process.name = processName;
        if (processName === 'GPU Process') {
          this.gpuProcess = process;
        } else if (processName === 'Browser') {
          this.browserProcess = process;
        } else if (processName === 'Renderer') {
          this.rendererProcesses.push(process);
        }
        break;
      case 'process_labels':
        this.process(pid).labels = event.args.labels;
        break;
      case 'process_sort_index':
        this.process(pid).sortIndex = event.args.sort_index;
        break;
      case 'trace_buffer_overflowed':
        this.process(pid).traceBufferOverflowedAt = event.args.overflowed_at_ts;
        break;
      case 'thread_name':
        const threadName: string = event.args.name;
        const thread = this.thread(pid, tid);
        thread.name = threadName;
        if (threadName === 'CrRendererMain') {
          this.process(pid).mainThread = thread;
        } else if (threadName === 'ScriptStreamerThread') {
          this.process(pid).scriptStreamerThread = thread;
        }
        break;
      case 'thread_sort_index':
        this.thread(pid, tid).sortIndex = event.args.sort_index;
        break;
      case 'IsTimeTicksHighResolution':
        this.process(pid).isTimeTicksHighResolution = event.args.value;
        break;
      case 'TraceConfig':
        this.process(pid).traceConfig = event.args.value;
        break;
      default:
        console.warn('unrecognized metadata:', JSON.stringify(event, null, 2));
        break;
    }
  }
}
