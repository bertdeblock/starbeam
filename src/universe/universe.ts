import type { anydom, minimal } from "@domtree/flavors";
import type { JSDOM } from "jsdom";
import { CELLS, scopedCached, scopedReactive } from "../decorator/reactive.js";
import { ReactiveDOM } from "../dom.js";
import { DomEnvironment } from "../dom/environment.js";
import { DOM, MINIMAL } from "../dom/streaming/compatible-dom.js";
import { TreeConstructor } from "../dom/streaming/tree-constructor.js";
import { HookBlueprint, HookConstructor } from "../hooks/simple.js";
import {
  HookCursor,
  HookProgramNode,
  HookValue,
} from "../program-node/hook.js";
import type {
  ContentProgramNode,
  ProgramNode,
} from "../program-node/interfaces/program-node.js";
import { Cell } from "../reactive/cell.js";
import type { AnyReactiveChoice } from "../reactive/choice.js";
import type { AbstractReactive, Reactive } from "../reactive/core.js";
import { Memo } from "../reactive/functions/memo.js";
import { Matcher, ReactiveMatch } from "../reactive/match.js";
import { InnerDict, ReactiveRecord } from "../reactive/record.js";
import { Static } from "../reactive/static.js";
import { Abstraction } from "../strippable/abstraction.js";
import { verified } from "../strippable/assert.js";
import { is, minimize } from "../strippable/minimal.js";
import { expected } from "../strippable/verify-context.js";
import { INSPECT } from "../utils.js";
import {
  Finalizer,
  IntoFinalizer,
  Lifetime,
  UniverseLifetime,
} from "./lifetime/lifetime.js";
import { Profile } from "./profile.js";
import { RenderedRoot } from "./root.js";
import { Timeline } from "./timeline.js";

export const TIMELINE_SYMBOL = Symbol("TIMELINE");

export class Universe {
  static jsdom(jsdom: JSDOM): Universe {
    return Universe.environment(
      DomEnvironment.jsdom(jsdom),
      `#<Universe jsdom>`
    );
  }

  /**
   * Create a new timeline in order to manage outputs using SimpleDOM. It's safe
   * to use SimpleDOM with the real DOM as long as you don't need runtime
   * features like event handlers and dynamic properties.
   */
  static environment(
    environment: DomEnvironment,
    description = `#<Universe>`,
    profile = Profile.Debug
  ): Universe {
    return new Universe(
      environment,
      Timeline.create(),
      Lifetime.scoped(),
      profile,
      description
    );
  }

  [INSPECT](): string {
    return this.#description;
  }

  /** @internal */
  finalize(object: object): void {
    Lifetime.finalize(this.#lifetime, this, object);
  }

  /** @internal */
  withAssertFrame(callback: () => void, description: string): void {
    this.#timeline.withAssertFrame(callback, description);
  }

  readonly #environment: DomEnvironment;
  readonly #profile: Profile;
  readonly #timeline: Timeline;
  readonly #lifetime: Lifetime;
  readonly #description: string;

  readonly dom: ReactiveDOM = new ReactiveDOM();
  readonly on = {
    destroy: (object: object, finalizer: IntoFinalizer) =>
      this.#lifetime.register(object, Finalizer.from(finalizer)),

    advance: (callback: () => void): (() => void) => {
      throw Error("todo: universe.on.advance");
    },
  } as const;

  get lifetime(): UniverseLifetime {
    return this.#lifetime;
  }

  readonly reactive: PropertyDecorator;
  readonly cached: PropertyDecorator;

  private constructor(
    document: DomEnvironment,
    timeline: Timeline,
    disposal: Lifetime,
    profile: Profile,
    description: string
  ) {
    this.#environment = document;
    this.#timeline = timeline;
    this.#lifetime = disposal;
    this.#profile = profile;
    this.#description = description;

    this.reactive = scopedReactive(timeline);
    this.cached = scopedCached(timeline);
  }

  hook<C extends HookConstructor<unknown>>(
    callback: C,
    description: string
  ): C extends HookConstructor<infer T> ? HookBlueprint<T> : never {
    return HookBlueprint.create(this, callback, description);
  }

  use<T>(
    hook: HookBlueprint<T>,
    { into }: { into: HookValue<T> }
  ): RenderedRoot<HookValue<T>> {
    let node = HookProgramNode.create(this, hook);
    return this.build(node, {
      cursor: HookCursor.create(),
      hydrate: () => into,
    });
  }

  render(
    node: ContentProgramNode,
    { append }: { append: anydom.ParentNode }
  ): RenderedRoot<minimal.ParentNode> {
    return this.build(node, {
      cursor: TreeConstructor.html(this.#environment),
      hydrate: (buffer: TreeConstructor) => {
        buffer.replace(this.#appending(append));
        return minimize(append);
      },
    });
  }

  get<T extends object, K extends keyof T>(
    object: T,
    key: K
  ): AbstractReactive<T[K]> {
    let cell = CELLS.get(object, key);

    if (cell) {
      return cell as AbstractReactive<T[K]>;
    }

    let descriptor = verified(
      getReactiveDescriptor(object, key),
      is.Present,
      expected(`the key passed to universe.get`)
        .toBe(`a property of the object`)
        .butGot(() => String(key))
    );

    if (descriptor.value) {
      return this.static(descriptor.value);
    } else {
      return this.memo(() => object[key], `getting ${String(key)}`);
    }
  }

  cell<T>(value: T, description = "anonymous"): Cell<T> {
    return Cell.create(value, this.#timeline, description);
  }

  /*
   * Create a memoized value that re-executes whenever any cells used in its
   * computation invalidate.
   */
  memo<T>(
    callback: () => T,
    description = `memo ${Abstraction.callerFrame().trimStart()}`
  ): Memo<T> {
    return Memo.create(callback, this.#timeline, description);
  }

  static<T>(value: T): Static<T> {
    return new Static(value);
  }

  match<C extends AnyReactiveChoice>(
    reactive: Reactive<C>,
    matcher: C extends infer ActualC
      ? ActualC extends AnyReactiveChoice
        ? Matcher<ActualC>
        : never
      : never,
    description = `match ${reactive.description}`
  ): ReactiveMatch<C, typeof matcher> {
    return ReactiveMatch.match(reactive, matcher, description);
  }

  record<T extends InnerDict>(dict: T): ReactiveRecord<T> {
    return new ReactiveRecord(dict);
  }

  build<Cursor, Container>(
    node: ProgramNode<Cursor, Container>,
    {
      cursor,
      hydrate,
    }: { cursor: Cursor; hydrate: (cursor: Cursor) => Container }
  ): RenderedRoot<Container> {
    let rendered = node.render(cursor);

    let container = hydrate(cursor);

    let root = RenderedRoot.create({
      rendered,
      container,
    });

    this.#lifetime.root(root);
    this.lifetime.link(root, rendered);

    return root;
  }

  #appending(parent: anydom.ParentNode): minimal.TemplateElement {
    let placeholder = MINIMAL.element(
      this.#environment.document,
      parent as minimal.ParentNode,
      "template"
    );

    DOM.insert(placeholder, DOM.appending(parent));
    return placeholder;
  }
}

/**
 * The descriptor may be on the object itself, or it may be on the prototype (as a getter).
 */
function getReactiveDescriptor(
  object: object,
  key: PropertyKey
): PropertyDescriptor | null {
  let target = object;

  while (target) {
    let descriptor = Object.getOwnPropertyDescriptor(target, key);

    if (descriptor) {
      return descriptor;
    }

    target = Object.getPrototypeOf(target);
  }

  return null;
}
