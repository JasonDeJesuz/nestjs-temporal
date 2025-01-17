import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import {
  NativeConnection,
  NativeConnectionOptions,
  Runtime,
  RuntimeOptions,
  Worker,
  WorkerOptions,
} from '@temporalio/worker';
import {
  TEMPORAL_MODULE_OPTIONS_TOKEN,
  TemporalModuleOptions,
} from './temporal.module-definition';
import { TemporalMetadataAccessor } from './temporal-metadata.accessors';
import { ActivityOptions } from './decorators';

@Injectable()
export class TemporalExplorer
  implements OnModuleInit, OnModuleDestroy, OnApplicationBootstrap {
  @Inject(TEMPORAL_MODULE_OPTIONS_TOKEN) private options: TemporalModuleOptions;
  private readonly logger = new Logger(TemporalExplorer.name);
  public get worker() {
    return this._worker;
  }
  private _worker: Worker;
  private timerId: ReturnType<typeof setInterval>;

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataAccessor: TemporalMetadataAccessor,
    private readonly metadataScanner: MetadataScanner,
  ) { }

  clearInterval() {
    this.timerId && clearInterval(this.timerId);
    this.timerId = null;
  }

  async onModuleInit() {
    await this.explore();
  }

  onModuleDestroy() {
    try {
      this.worker?.shutdown();
    } catch (err: any) {
      this.logger.warn('Temporal worker was not cleanly shutdown.', { err });
    }

    this.clearInterval();
  }

  onApplicationBootstrap() {
    this.timerId = setInterval(() => {
      if (this.worker) {
        this.worker.run();
        this.clearInterval();
      }
    }, 1000);
  }

  async explore() {
    const workerConfig = this.getWorkerConfigOptions();
    const runTimeOptions = this.getRuntimeOptions();
    const connectionOptions = this.getNativeConnectionOptions();

    // should contain taskQueue
    if (workerConfig.taskQueue) {
      const activitiesFunc = await this.handleActivities();

      if (runTimeOptions) {
        this.logger.verbose('Instantiating a new Core object');
        Runtime.install(runTimeOptions);
      }

      const workerOptions = {
        activities: activitiesFunc,
      } as WorkerOptions;
      if (connectionOptions) {
        this.logger.verbose('Connecting to the Temporal server');
        workerOptions.connection = await NativeConnection.connect(
          connectionOptions,
        );
      }

      this.logger.verbose('Creating a new Worker');
      this._worker = await Worker.create(
        Object.assign(workerOptions, workerConfig),
      );
    }
  }

  getWorkerConfigOptions(): WorkerOptions {
    return this.options.workerOptions;
  }

  getNativeConnectionOptions(): NativeConnectionOptions | undefined {
    return this.options.connectionOptions;
  }

  getRuntimeOptions(): RuntimeOptions | undefined {
    return this.options.runtimeOptions;
  }

  getActivityClasses(): object[] | undefined {
    return this.options.activityClasses;
  }

  async handleActivities() {
    const activitiesMethod = {};

    const activityClasses = this.getActivityClasses();
    const activities: InstanceWrapper[] = this.discoveryService
      .getProviders()
      .filter(
        (wrapper: InstanceWrapper) =>
          this.metadataAccessor.isActivities(
            !wrapper.metatype || wrapper.inject
              ? wrapper.instance?.constructor
              : wrapper.metatype,
          ) &&
          (!activityClasses || activityClasses.includes(wrapper.metatype)),
      );

    const activitiesLoader = activities.flatMap((wrapper: InstanceWrapper) => {
      const { instance } = wrapper;
      const isRequestScoped = !wrapper.isDependencyTreeStatic();

      return this.metadataScanner.scanFromPrototype(
        instance,
        Object.getPrototypeOf(instance),
        async (key: string) => {
          if (this.metadataAccessor.isActivity(instance[key])) {
            const metadata = this.metadataAccessor.getActivity(instance[key]) as ActivityOptions;

            let activityName = key;
            if (metadata?.name) {
              if (typeof metadata.name === 'string') {
                activityName = metadata.name;
              }
              else {
                const activityNameResult = metadata.name(instance);
                if (typeof activityNameResult === 'string') {
                  activityName = activityNameResult;
                }
                else {
                  activityName = await activityNameResult;
                }
              }
            }
            if (isRequestScoped) {
              // TODO: handle request scoped
            } else {
              activitiesMethod[activityName] = instance[key].bind(instance);
            }
          }
        },
      );
    });
    await Promise.all(activitiesLoader);
    return activitiesMethod;
  }
}
