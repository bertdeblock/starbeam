import type { Stack, StackFrame } from "../stack.js";
import {
  type ValidatorDescription,
  StaticValidatorDescription,
} from "./validator.js";

export type MarkerType =
  | "collection:key-value"
  | "collection:value"
  | "collection:value:entry"
  | "collection:key-value:entry";

export type ValueType =
  | "implementation"
  | "static"
  | "cell"
  | "formula"
  | "resource"
  | MarkerType;

export type UserFacingDescription =
  | StaticDescription
  | CellDescription
  | FormulaDescription
  | MarkerDescription;

export type Description = UserFacingDescription | ImplementationDescription;

export interface DescriptionType {
  from(create: CreateDescription): Description;
}

type DescriptionDetails =
  | string
  | {
      type: "member";
      parent: Description;
      name: string;
    }
  | { type: "method"; parent: Description; name: string };

export interface DescriptionArgs {
  name?: DescriptionDetails;
  description?: Description;
  transform?: (description: Description) => Description;
  stack?: Stack;
}

export const Description = {
  is: (value: unknown): value is Description => {
    return value instanceof AbstractDescription;
  },

  from: (
    type: DescriptionType,
    args: DescriptionArgs,
    validator: ValidatorDescription
  ): Description => {
    if (args.description) {
      return args.description;
    }

    const description = type.from({ ...args, validator });

    if (args.transform) {
      return args.transform(description);
    } else {
      return description;
    }
  },
};

export abstract class AbstractDescription {
  abstract readonly type: ValueType;

  /**
   * The name of the storage, as specified by the user. If no name was specified, the name is
   * `undefined`.
   */
  #name: DescriptionDetails | undefined;

  /**
   * The stack (in code that called into Starbeam) that created this storage.
   */
  #stack: Stack | undefined;

  #validator: ValidatorDescription;

  constructor({ name, stack, validator }: CreateDescription) {
    this.#name = name;
    this.#stack = stack;
    this.#validator = validator;
  }

  abstract userFacing(): UserFacingDescription;

  implementation(details: { reason: string }) {
    return ImplementationDescription.from({
      ...details,
      validator: this.#validator,
      userFacing: this.userFacing(),
      stack: this.#stack,
    });
  }

  get validator(): ValidatorDescription {
    return this.#validator;
  }

  get fullName(): string {
    if (this.#name !== undefined) {
      if (typeof this.#name === "string") {
        return this.#name;
      } else {
        return `${this.#name.parent.fullName}${this.name}`;
      }
    } else {
      return `{anonymous ${this.type}}`;
    }
  }

  get name(): string {
    if (this.#name) {
      if (typeof this.#name === "string") {
        return this.#name;
      } else {
        switch (this.#name.type) {
          case "member":
            return `->${this.#name.name}`;
          case "method":
            return `.${this.#name.name}()`;
        }
      }
    } else {
      return `{anonymous ${this.type}}`;
    }
  }

  method(this: Description, name: string): Description {
    return FormulaDescription.from({
      name: {
        type: "method",
        parent: this,
        name,
      },
      validator: this.#validator,
      stack: this.#stack,
    });
  }

  member(this: Description, name: string): Description {
    return FormulaDescription.from({
      name: {
        type: "member",
        parent: this,
        name,
      },
      validator: this.#validator,
      stack: this.#stack,
    });
  }

  memberArgs(this: Description, name: string): DescriptionArgs {
    return {
      name: {
        type: "member",
        parent: this,
        name,
      },
      stack: this.#stack,
    };
  }

  describe({ source = false }: { source?: boolean } = {}): string {
    if (this.#name === undefined) {
      return `${this.fullName} @ ${this.#caller}`;
    } else if (source) {
      return `${this.fullName} @ ${this.#caller}`;
    } else {
      return this.fullName;
    }
  }

  get #caller(): string {
    const caller = this.#stack?.caller;

    if (caller !== undefined) {
      return caller.display;
    } else {
      return "<unknown>";
    }
  }

  get frame(): StackFrame | undefined {
    return this.#stack?.caller;
  }
}

abstract class AbstractUserFacingDescription extends AbstractDescription {
  userFacing(): UserFacingDescription {
    return this as UserFacingDescription;
  }
}

export interface ImplementationDetails {
  readonly reason: string;
  readonly userFacing: UserFacingDescription;
}

export class ImplementationDescription extends AbstractDescription {
  static from(
    create: CreateDescription & ImplementationDetails
  ): ImplementationDescription {
    return new ImplementationDescription(create, create);
  }

  readonly type = "implementation";

  readonly #implementation: ImplementationDetails;

  constructor(
    create: CreateDescription,
    implementation: ImplementationDetails
  ) {
    super(create);

    this.#implementation = implementation;
  }

  userFacing(): UserFacingDescription {
    return this.#implementation.userFacing;
  }
}

export interface CreateDescription extends DescriptionArgs {
  validator: ValidatorDescription;
}

export interface CreateStaticDescription {
  name?: string;
  stack?: Stack;
}

export class StaticDescription extends AbstractUserFacingDescription {
  static from(
    options: CreateStaticDescription | StaticDescription
  ): StaticDescription {
    if (Description.is(options)) {
      return options;
    }

    return new StaticDescription({
      ...options,
      validator: new StaticValidatorDescription(),
    });
  }

  readonly type = "static";
}

export class CellDescription extends AbstractUserFacingDescription {
  static from(
    this: void,
    options: CreateDescription | CellDescription
  ): CellDescription {
    if (Description.is(options)) {
      return options;
    }

    return new CellDescription(options);
  }

  readonly type = "cell";
}

export class MarkerDescription extends AbstractUserFacingDescription {
  static type(type: MarkerType): DescriptionType {
    return {
      from: (options) => MarkerDescription.from(type, options),
    };
  }

  static from(
    this: void,
    type: MarkerType,
    options: CreateDescription | MarkerDescription
  ): MarkerDescription {
    if (Description.is(options)) {
      return options;
    }

    return new MarkerDescription(options, type);
  }

  private constructor(options: CreateDescription, readonly type: MarkerType) {
    super(options);
  }
}

export class FormulaDescription extends AbstractUserFacingDescription {
  static from(
    options: CreateDescription | FormulaDescription
  ): FormulaDescription {
    if (Description.is(options)) {
      return options;
    }

    return new FormulaDescription(options);
  }

  readonly type = "formula";
}
