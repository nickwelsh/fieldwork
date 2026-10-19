# Fieldwork

Generate application-owned React forms from Laravel FormRequests. Effect 4 owns form state, subscriptions, validation, submission, metadata decoding, and generation workflows. Native Effect scopes, fibers, and deferred results manage execution and cancellation; the Node adapter supplies filesystem and subprocess services. React bindings, source extraction, and submission transports stay separate from the portable form contract.

This repository uses **Vite+** for development, packaging, formatting, type-aware linting, and Vitest. TypeScript uses strict mode, exact optional properties, unchecked indexed access, no implicit returns, no unused symbols, and erasable syntax. The lint configuration adapts the supplied Roost configuration, with documented exceptions at native framework and process-adapter boundaries. PHP uses Pint and PHPStan at maximum level.

## Packages

| Package                | Responsibility                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `@fieldwork/core`      | Portable definitions, constraint validation, Effect form sessions, route binding                |
| `@fieldwork/react`     | React subscriptions, bound fields/components/groups, automatic layouts                          |
| `@fieldwork/inertia`   | Inertia submission, server errors, upload progress, scoped cancellation                         |
| `@fieldwork/generator` | Driver contracts, generation orchestration, artifact synchronization and drift checks           |
| `@fieldwork/laravel`   | Node generator integration, backend enum generation and HTTP operation provider                 |
| `fieldwork/laravel`    | Laravel configuration, FormRequest extraction, `fieldwork:export` and `fieldwork:http` commands |
| `examples/react`       | Runnable profile form with a composite address field group                                      |

Packages are local and have not been published to npm or Packagist. The runtime uses **Effect 4.0.2**.

The [documentation site](https://docs.nickwelsh.me/fieldwork) includes usage guides and a Refquill-generated TypeScript/PHP API reference. Run `pnpm docs:dev` locally or see [apps/docs](apps/docs/README.md) for release deployment setup.

The [performance benchmark](benchmarks/README.md) includes a mounted React form with up to 5,000 inputs and a headless editing/subscription harness, with recorded measurements and reproduction instructions.

Existing integrations must replace their form hook factory with direct `createFieldwork` registries, import context hooks from `@fieldwork/react`, and update field components to `value`, `setValue`, `touch`, and `errors`. Remove the previous form-library dependencies and application hook/context modules. Custom source drivers, operation providers, and submission drivers return Effects; wrap synchronous work with `Effect.sync`, and use `Effect.callback` or `Effect.tryPromise` at asynchronous platform boundaries.

## Run the monorepo

Requires Node 24.11+, pnpm (the pinned version is in `package.json`), Vite+ (`vp`), PHP 8.4.1+ for the locked development dependencies, and Composer. The PHP package supports PHP 8.3+; CI uses PHP 8.4.

```sh
vp install
composer install --working-dir=packages/laravel
vp run build
vp run generate:example
vp run dev
```

The example extracts a real PHP FormRequest using the Laravel package, without requiring a full Laravel application. Its submission driver displays the payload locally. The address lookup uses a fixed sample suggestion; connect your preferred provider, including Google Places, in application code.

```sh
vp check
vp exec tsc --noEmit
vp test run
composer --working-dir=packages/laravel test
composer --working-dir=packages/laravel check
php packages/laravel/vendor/bin/pint --test packages/laravel/src packages/laravel/tests examples/react/php
vp exec tsx packages/generator/src/cli.ts generate --config examples/react/fieldwork.config.ts --check
```

`--check` detects drift without writing generated files. In environments that restrict local sockets, add `--debug --no-progress` to PHPStan to run without worker processes.

## Public form contract

Any package can produce forms for Fieldwork. Generation is optional: the React runtime depends on `@fieldwork/core`'s public contract, not on the Laravel package or generator. Zero for Laravel and other integrations can implement this contract in their own packages with type-only imports.

A `FormDescriptor` is a versioned object pairing a reusable `FormDefinition` with a submission strategy and optional record-specific defaults:

```ts
import type { FormDefinition, FormDescriptor, SubmissionCallback } from '@fieldwork/core';

type TodoValues = { title: string; done: boolean };

// Produced by your integration; fields retain literal component names and keys.
declare const definition: FormDefinition<TodoValues>;

const httpForm = {
    version: 1,
    definition,
    defaultValues: { title: 'Buy milk', done: false },
    submission: {
        driver: 'http',
        binding: { kind: 'http', url: '/todos/42', method: 'patch' },
    },
} satisfies FormDescriptor<TodoValues>;
```

Register a matching runtime executor, for example `submissions: { http: inertia() }`, in `createFieldwork`. The producer supplies the target; the application chooses how that target executes. Existing Laravel generation now emits this descriptor from each generated action's `.form(parameters)` helper. Generator submission keys still select runtime driver names.

For an integration that owns execution, supply a callback instead of a driver:

```ts
const submit: SubmissionCallback<TodoValues> = async (values, { signal }) => {
    // prepareAndSubmit represents your integration's own mutation execution.
    const result = await prepareAndSubmit(values, signal);
    if (result.errors) return { status: 'invalid', errors: result.errors };
    return { status: 'success' };
};

const callbackForm = {
    version: 1,
    definition,
    defaultValues: { title: 'Buy milk', done: false },
    submission: { submit },
} satisfies FormDescriptor<TodoValues>;
```

`submission` accepts exactly one strategy. Callbacks receive validated output and `{ signal, onProgress }`, and return a `SubmissionResult` directly or through a Promise. Results are `success`, `invalid` (field/root errors), `failure` (an expected error), `cancelled`, or `defect`. Use `SubmissionCallback<Output, Success, Error>` for typed result payloads. Thrown exceptions and rejected Promises settle as defects; expected failures must be returned explicitly. Report success only after authoritative acceptance, not merely an optimistic local write.

A hook in another package can return `{ form: callbackForm }` without importing the application registry or creating a session:

```tsx
const { form } = useMutation(todo.update()); // Supplied by the external integration.
return <Form form={form} />;

// For programmatic field access:
const instance = useForm(form);
return <Form form={instance} />;
```

`Form` creates the Fieldwork session. Its components read values, errors, and submission state from that one session. A producer must not synchronize a separate editable-value store with Fieldwork. Definition defaults are the fallback; descriptor defaults override them, and an explicit `defaultValues` option overrides descriptor defaults. Defaults initialize a mount rather than resetting edits on rerender. Use a key or explicit reset to switch records. Callbacks update on committed renders, while an in-flight submission keeps its captured handler and values.

Cancellation aborts the callback's signal and suppresses late outcomes and progress. The integration owns any underlying cancellation or cleanup; an already-enqueued durable mutation may still execute. Explicit `submission` or `operation` options replace the descriptor's strategy for that form instance.

For JSON producers, export `FormDescriptorData`, which excludes runtime schemas and callbacks. Its version-1 format is checked by `FormDescriptorSchema`, `parseFormDescriptor(json)`, or `parseFormDescriptorEffect(json)`. All fields, props, constraints, defaults, and driver bindings in this data format are JSON values. Fieldwork compiles field constraints into validation at runtime; native Effect schemas remain an optional runtime extension on `FormDefinition` for decoding and transformations. Validate untrusted JSON at the producer boundary before rendering. TypeScript producers should preserve literal field/component keys using `satisfies` or `defineForm<Values>()`, and declare editable default-value types explicitly so a blank initial value does not narrow the entire draft to a string literal.

Bare definitions, existing `bindForm` calls, and initialized form instances remain supported. `bindForm` now includes `version: 1`; `BoundForm` remains available for existing driver-only integrations. No Fieldwork-owned Zero adapter is required or included.

## Register application components

Fieldwork owns the form session and React contexts. Field components receive presentation metadata and subscribe to their own value, errors, and metadata:

```tsx
import { useFieldContext, type FieldProps } from '@fieldwork/react';
import { useId } from 'react';

export function TextField({ label, helpText, constraints }: FieldProps<string>) {
    const field = useFieldContext<string>();
    const id = useId();
    return (
        <div>
            <label htmlFor={id}>{label}</label>
            <input
                id={id}
                name={field.name}
                value={field.value}
                onChange={(event) => field.setValue(event.target.value)}
                onBlur={field.touch}
                required={constraints.required}
                minLength={constraints.minLength}
                maxLength={constraints.maxLength}
                aria-invalid={field.errors.length > 0}
            />
            {helpText && <p>{helpText}</p>}
            {field.errors.map((error, index) => (
                <p key={index} role="alert">
                    {error}
                </p>
            ))}
        </div>
    );
}
```

`setValue` accepts a value or an updater. `touch()` records interaction; `meta` exposes `isTouched`, `isDirty`, and `isValid`. Errors are normalized strings.

```tsx
import { useFormContext } from '@fieldwork/react';

export function SubmitButton({ label = 'Save' }: { label?: string }) {
    const form = useFormContext();
    return (
        <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
                <button type="submit" disabled={isSubmitting}>
                    {label}
                </button>
            )}
        </form.Subscribe>
    );
}
```

Register the components directly, retaining their literal keys:

```ts
import { createFieldwork } from '@fieldwork/react';
import { inertia } from '@fieldwork/inertia';
import { TextField, CheckboxField } from './field-components';
import { SubmitButton, FormErrors } from './form-components';
import { fieldGroups } from './address-group';

const fieldwork = createFieldwork({
    fieldComponents: { TextField, CheckboxField },
    formComponents: { SubmitButton, FormErrors },
    fieldGroups,
    submissions: { web: inertia({ visit: { preserveScroll: true, errorBag: 'profile' } }) },
    submitComponent: 'SubmitButton',
});

export default fieldwork;
export const { Form, useForm } = fieldwork;
```

Avoid annotating registries as broad `Record<string, ...>` types: literal keys power generated enums and typed bound components. Context hooks are exported by `@fieldwork/react`, so application context and hook-factory modules are unnecessary.

### Inertia Effect

For [Inertia Effect](https://github.com/nickwelsh/inertia-effect), change the runtime import to:

```ts
import { inertia } from '@fieldwork/inertia/effect';

// Register under the same submission key used by your generated definitions.
const submissions = {
    web: inertia({ visit: { preserveScroll: true, errorBag: 'profile' } }),
};
```

This adapter composes the application's `router.visitEffect` directly. It waits for navigation completion, including the page commit and renderer acknowledgement. Effectful visit callbacks run in the submitting context. The generator remains `@fieldwork/inertia/generator`: both adapters use the same HTTP bindings. An optional `router` accepts your own Inertia Effect router instance.

Success and validation outcomes become Fieldwork success and field errors. Navigation failures and handled HTTP/network exceptions become submission failures; defects remain Effect defects. Prevented, interrupted, cancelled, discarded, and redirect outcomes become cancelled submissions. A redirect starts another navigation without awaiting its validation result, so it cannot confirm this submission's success. Aborting the submission signal or interrupting its fiber interrupts the native visit and releases the listener; Inertia can finish an already-started atomic history/render commit before cancellation completes.

The fork retains the `@inertiajs/core` package name. Install it as that package so your application and Fieldwork share one router. At revision `18db6eba25c95837cf303745e46fc6201bc35177`, the repository does not contain built exports or a package preparation hook. A direct Git dependency therefore lacks executable exports. Until the fork adds a preparation hook, build and pack its core from Git:

```sh
git clone https://github.com/nickwelsh/inertia-effect.git
cd inertia-effect
git checkout 18db6eba25c95837cf303745e46fc6201bc35177
pnpm install --frozen-lockfile --filter @inertiajs/core...
pnpm --dir packages/core build
pnpm --dir packages/core pack --out /tmp/inertia-core-effect.tgz
# Run in your application:
pnpm add /tmp/inertia-core-effect.tgz
```

Use the matching forked React/Vue/Svelte adapter in your application too. Fieldwork's development dependency is a core tarball built from this pinned Git revision; its source and rebuild instructions are recorded alongside the archive. Ordinary Inertia applications keep the existing `@fieldwork/inertia` import.

## Laravel rules and default components

Install the local Composer package into a Laravel app using a Composer path repository. Laravel discovers its service provider automatically. Publish configuration with:

```sh
php artisan vendor:publish --tag=fieldwork-config
```

Map rule-inferred value types to your generated enum:

```php
use App\Enums\FormField;

return [
    'requests' => ['app/Http/Requests'],
    'fields' => [
        'types' => [
            'string' => FormField::TextField,
            'integer' => FormField::NumberField,
            'number' => FormField::NumberField,
            'boolean' => FormField::CheckboxField,
            'date' => FormField::DateField,
            'enum' => FormField::SelectField,
            'file' => FormField::FileField,
        ],
        'rules' => [
            'email' => ['component' => FormField::TextField, 'props' => ['type' => 'email']],
            'url' => ['component' => FormField::TextField, 'props' => ['type' => 'url']],
        ],
        'fallbackType' => 'string',
    ],
];
```

Type mapping establishes the default component and props; the first matching rule mapping in configuration takes priority; `fields()` can override them. Register only components that exist in your application. Arrays and objects require explicit components/configuration.

A basic FormRequest needs only `rules()`:

```php
public function rules(): array
{
    return [
        'first_name' => ['required', 'string', 'max:255'],
        'email' => 'required|email',
        'newsletter' => ['required', 'boolean'],
    ];
}
```

The default label is the title-case version of the final named field segment: `first_name` becomes `First Name`, and `billing.city` becomes `City`.

```php
use Fieldwork\Laravel\Field;

public function fields(): array
{
    return [
        'email' => Field::make()->helpText('We use this for profile updates.'),
        'first_name' => Field::make(FormField::TextField)->label('Given Name')->props(['placeholder' => 'Alex']),
    ];
}
```

Props must be JSON values. Generation checks supplied props against the application's component types and rejects unknown components, unknown props, invalid values, and missing required props.

## Generate definitions, actions, and enums

```ts
// fieldwork.config.ts
import { defineConfig } from '@fieldwork/generator';
import { laravel } from '@fieldwork/laravel/generator';
import { react } from '@fieldwork/react/generator';
import { inertia } from '@fieldwork/inertia/generator';

const app = laravel();

export default defineConfig({
    sources: { app },
    framework: react('./resources/js/forms/index.ts'),
    submissions: { web: inertia({ bindings: app.http() }) },
    output: {
        forms: './resources/js/generated/forms',
        actions: './resources/js/generated/actions',
    },
});
```

Paths resolve relative to the config file. React inspects the default-exported `createFieldwork` setup and its direct component registries and field groups without executing UI modules. Setup options and group declarations must be statically inspectable.

Request discovery and enum targets belong in `config/fieldwork.php`:

```php
return [
    'requests' => ['app/Http/Requests'],
    'enums' => [
        'fields' => App\Enums\FormField::class,
        'components' => App\Enums\FormComponent::class,
        'groups' => App\Enums\FormGroup::class,
    ],
    'profiles' => [
        'fixtures' => ['requests' => ['tests/Fixtures']],
    ],
    'fields' => [/* existing type and rule mappings */],
];
```

Enum targets are a declarative array of class names or `null` to disable a registry. Paths follow the application's Composer PSR-4 mappings. The Laravel integration reads only this array and its PHP imports before booting Laravel, writes the enums, then extracts schemas. Config and requests can therefore reference generated enum cases on the first run. This uses no config closures and remains compatible with Laravel config caching. Clear cached config after changing backend discovery or mappings. `laravel({ root, profile: 'fixtures' })` selects a backend discovery profile; directories are defined only in PHP.

```sh
fieldwork fields                 # enums only; useful for initial setup
fieldwork generate               # enums, forms, and named route actions
fieldwork generate --check       # CI drift check
```

Routes whose controller/closure parameters reference a FormRequest generate named action modules. For `profile.update` with `/users/{user}`, use:

```tsx
import { update } from './generated/actions/profile';

<Form form={update.form({ user: user.id })} defaultValues={values} />;
```

Every generated operation exposes a version-1 `FormDescriptor` through `action.form(parameters)`; call `action.form()` when there are no parameters. Optional Laravel parameters are optional properties. The result pairs the unchanged schema with a named executor and its binding. For an explicit HTTP binding:

```ts
bindForm(definition, {
    driver: 'web',
    binding: { kind: 'http', url: '/users/42', method: 'patch' },
});
```

Schemas can render directly for local state/validation. Submission requires a bound operation and a registered executor, or a per-form `submission` executor override.

## Layouts and form components

```tsx
<Form form={update.form({ user: user.id })} defaultValues={values}>
    {({ fields, components, groups }) => (
        <>
            <fields.first_name />
            <fields.email label="Contact Email" />
            <groups.address label="Delivery Address" />
            <components.FormErrors />
            <components.SubmitButton label="Save" />
        </>
    )}
</Form>
```

Unknown fields and invalid component props are TypeScript errors. Nested named fields use nested access, such as `<fields.billing.city />`. Bracket paths such as `rows[0].name` expose `fields.rows[0].name`; assign that binding to a capitalized variable, such as `const RowName = fields.rows[0].name`, then render `<RowName />`. A container field can render through `<fields.billing />` while also exposing its child bindings.

Custom children render exactly the supplied layout. Without children, Fieldwork renders ungrouped fields and each group once in field order, followed by the configured submit component.

Each mounted `Form` owns an independent Effect form session. Bound component identity stays stable across metadata and field-order changes, preserving focus and drafts. Adding or removing a container's child bindings creates a new immutable container binding; unchanged child bindings retain their identity. `defaultValues` initializes the mount; use a React `key` when switching records, or call `form.reset()` deliberately.

For direct form access:

```tsx
const profile = useForm(update.form({ user: user.id }), { defaultValues: values });
// profile.form exposes typed Field, Subscribe, value updates, reset, submit, and cancellation.
return <Form form={profile} />;
```

Field reads below optional or nullable containers include `undefined`; dynamic array indexes and record keys can also be missing. Writes retain the declared leaf type. Array paths accept dot and bracket indexes, including equivalent padded indexes, while object keys such as `"01"` remain literal. Missing containers use the encoded Effect schema, generated metadata, or baseline shape to determine whether to create an array or object. Without an inspectable shape, initialize an array explicitly with `append` or a whole-field value. `form.session.resolvePath()` exposes the canonical path used for field metadata and errors.

Numeric object keys support dot and bracket paths and retain their declared value types. Structural helpers (`append`, `remove`, and `move`) accept dynamic arrays. Tuples, including tuples with a variadic rest, require slot edits or a whole-field replacement so their fixed positions and lengths remain intact.

Validation runs only on submit. Generated constraints produce native Effect schemas. The session decodes the captured draft with `Schema.decodeUnknownEffect` before submitting, mapping schema issues to field and root errors. Inertia awaits the visit lifecycle, maps scoped Laravel errors into the session, forwards progress, and cancels the instance's own visit on cancellation/unmount. A driver returns an Effect producing `success`, `invalid`, `cancelled`, `failure`, or `defect`; provide `onResult` to react to the outcome. Root form errors are available at `state.errors['']`; field errors are available through field contexts.

Native schema record keys containing dots, brackets, or other segments that field paths cannot represent produce root validation errors. Their validation messages remain available without turning an invalid draft into a submission defect.

Generated constraint schemas are compiled once per definition object and reused across submissions and sessions. Definitions are readonly; supply a new definition object when changing rules. Schema construction runs inside the submission Effect, so construction defects settle the submission instead of leaving it pending.

Execution snapshots freeze the result envelope and validation messages while preserving typed success/error payload identity. Domain payloads can contain cycles, symbols, or application objects; Fieldwork does not clone them. React installs committed submission options before child layout effects can submit, and metadata-only definition updates preserve bound input identity and focus.

Hidden or unmounted React owners suppress progress and result callbacks. Notifications produced before layout activation are deferred until the owner is active; cancellation, reset, and replacement submissions discard stale queued callbacks.

An Inertia global `before` veto settles as `cancelled`, even though Inertia emits no visit completion callback. Detection observes the native event in the window capture phase, is scoped to the exact visit, and supports asynchronous dispatch by injected routers. Injected routers need only `visit` and must follow Inertia's visit lifecycle. Cancellation during `before` dispatch prevents visit acceptance.

An Inertia transport payload must be a plain record or `FormData`. Nested values support plain records, arrays, strings, booleans, null/undefined, finite numbers, valid dates, and files/blobs. Unsupported application objects, nonfinite numbers, invalid dates, and cyclic containers return `failure` before starting a visit.

## Typed Effect operations and headless sessions

Application operations preserve their success, domain error, and service types. Pass native Effect schemas directly: draft values and decoded output can have different types. Decoding and submission share one interruptible Effect, including asynchronous schema checks. The session supplies its execution scope; supply a runner when the schema decoder or operation requires additional services.

```ts
import { createFormSession, defineForm } from '@fieldwork/core';
import { Context, Effect, Schema } from 'effect';

type SaveError = { readonly _tag: 'SaveFailed'; readonly message: string };
class ProfileApi extends Context.Service<
    ProfileApi,
    {
        readonly save: (values: { age: number }) => Effect.Effect<{ id: number }, SaveError>;
    }
>()('ProfileApi') {}

const definition = defineForm<{ age: string }, { age: number }>()({
    id: 'Profile',
    defaultValues: { age: '' },
    fields: {
        age: {
            name: 'age',
            type: 'string',
            component: 'TextField',
            label: 'Age',
            props: {},
            constraints: {},
            nullable: false,
            serverRules: [],
        },
    },
    groups: {},
    schema: Schema.Struct({ age: Schema.NumberFromString.check(Schema.isFinite()) }),
});

const services = Context.make(ProfileApi, {
    save: (values) => Effect.succeed({ id: values.age }),
});
const session = createFormSession({
    definition,
    operation: (output) =>
        Effect.gen(function* () {
            const api = yield* ProfileApi;
            return yield* api.save(output); // output.age is a number.
        }),
    run: Effect.runPromiseWith(services),
});

session.setValue('age', '42'); // Draft age remains a string.
const result = await Effect.runPromise(session.submitEffect());
if (result.status === 'success') console.log(result.value?.id);
if (result.status === 'failure') console.log(result.error.message);
session.dispose();
```

Schema decoder services are inferred from the definition and retained through `bindForm` and React bindings. The runner must provide the services required by both decoding and the operation; TypeScript rejects a missing or insufficient runner.

`submitEffect()` describes a lazy wait for the session's submission and composes with application Effects. `submit()` starts the same work immediately and returns a Promise for event handlers. Concurrent callers of either API share one validation and submission. The session owns the execution fiber and scope, and an optional configured runner supplies application services. Interrupting a waiting fiber leaves the shared execution active. Use `session.cancel()`, `reset()`, or `dispose()` to interrupt the execution for every caller. Effect finalizers release resources on completion and cancellation.

React `useForm` accepts the same `operation` and `run` options. React subscriptions consume stable snapshots from the session's native Effect atom; headless consumers use `getSnapshot()` and `subscribe()`. Each subscription has a scoped lifetime and disposal removes every listener. Submit captures the current draft, coalesces duplicate submissions, and commits the submitted baseline only on success. Edits made during submission stay dirty; stale server errors cannot overwrite fields changed after submission. Cancellation interrupts decoding and submission and suppresses late progress and results. Typed domain errors produce `failure`; unexpected defects produce `defect`.

## Composite groups

Use Fieldwork's `withFieldGroup` to let one component own several backend fields:

```tsx
import { withFieldGroup } from '@fieldwork/react';

const addressDefaults: {
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    postalCode: string;
} = { line1: '', line2: null, city: '', state: '', postalCode: '' };

export const AddressAutocomplete = withFieldGroup({
    defaultValues: addressDefaults,
    props: { label: 'Address' },
    render: function AddressAutocomplete({ group, label }) {
        // In your provider's selection callback:
        // group.setFieldValue('line1', place.line1);
        // group.setFieldValue('line2', place.line2);
        // group.setFieldValue('city', place.city);
        // group.setFieldValue('state', place.state);
        // group.setFieldValue('postalCode', place.postalCode);
        // Render group.Field subscriptions for each slot's errors.
        // group.touchField('line1') records interaction.
        return (
            <fieldset>
                <legend>{label}</legend>
                {/* Provider widget */}
            </fieldset>
        );
    },
});

export const fieldGroups = { AddressAutocomplete };
```

```php
use App\Enums\FormGroup;
use Fieldwork\Laravel\FieldGroup;

public function groups(): array
{
    return [
        'address' => FieldGroup::make(FormGroup::AddressAutocomplete)
            ->label('Delivery Address')
            ->fields([
                'line1' => 'address_line_1',
                'line2' => 'address_line_2',
                'city' => 'city',
                'state' => 'state',
                'postalCode' => 'zip',
            ]),
    ];
}
```

Every slot must be mapped to a known field with a compatible type for both reading and writing. This includes scalar and enum values, nullability, explicit undefined, and array mutability. Fields can belong to only one group. The runnable example demonstrates all five writes, group error subscriptions, and a readout of the resulting values.

Container slots are checked against the complete generated value shape, including array elements, nested object fields, optional properties, and index signatures. Recursive or otherwise uninspectable slot types are rejected during generation.

## Validation boundaries

Constraints include `required`, reactive `required_if`/`required_unless`/`required_with`/`required_without`, string `minLength`/`maxLength`, numeric `min`/`max`, array `minItems`/`maxItems`, enum options, and format hints. Client checks improve feedback; Laravel remains authoritative for validation and authorization. Email/URL checks are approximate. Date rules, file size/content rules, unique/existence queries, closures, custom rules, and unsupported conditions remain server validation and produce diagnostics.

Draft defaults are empty strings (including enum drafts), zero for numbers, false for booleans, empty arrays/objects, and null for nullable/file fields. Enum draft types include the blank string until selection; option validation rejects it when required.

Required object fields reject empty plain records, matching Laravel's empty associative-array behavior. Conditional presence rules also treat an empty record as absent.

Wildcard rule validation checks every array position, including sparse holes; required child fields reject missing rows. Conditional references such as `contacts.*.enabled` resolve against the concrete row being validated, including nested wildcard keys. Conditional requirements follow Laravel's missing-dependency and boolean-comparison behavior. Rendering repeated fields belongs to an application-owned parent array component using the typed `form.Field`, `form.Subscribe`, and `setFieldValue` APIs; this version does not generate repeaters or bound wildcard child components.

Generation requires rules that can be described without authenticated/live request values. FormRequests are instantiated without running validation or authorization; request-dependent rules may need a dedicated source driver. Registry inspection supports callable components and statically inspectable `withFieldGroup` declarations; complex wrappers may need a framework driver that supplies a manifest.

## Extending drivers

A `SourceDriver<E, R>` returns an Effect producing the versioned portable `Extraction` contract: schemas and diagnostics. Its optional artifact preparation also returns an Effect. Laravel's scoped subprocess integration extracts schemas and prepares PHP enums; `fieldwork:export` has no route flag or HTTP dependency. `ExtractionSchema` and `parseExtractionEffect` decode external metadata with native Effect Schema failures; synchronous parse helpers execute the same decoder at compiler boundaries.

An `OperationProvider<TBinding, E, R>` associates a source's schema IDs with named operations, parameters and typed transport bindings through an Effect. Laravel's `app.http()` invokes the separate `fieldwork:http` provider. Inertia's generator consumes this portable HTTP capability; its runtime has no Laravel dependency. `defineSubmission`, `defineConfig`, and `generate` preserve provider errors and required services. `generate(config, options)` returns an Effect requiring filesystem services plus the configured providers' services; the CLI supplies native Node services and runs the workflow with `NodeRuntime.runMain`.

Use `defineSubmission({ bindings, imports, emitBinding })` to adapt another operation provider into generated actions. `emitBinding` generates the runtime binding expression. A runtime `SubmissionDriver` receives the parsed form data, portable JSON binding, abort signal and optional progress callback, then returns an Effect producing a `SubmissionResult`. Effects can be interrupted through session cancellation; asynchronous drivers should implement abort cleanup. `defineSubmissionDriver({ accepts, submit })` validates bindings and exposes a typed executor. For a mutation transport such as Zero, bindings can identify a mutation and its context; the executor maps values/context into mutation arguments and waits for server acceptance before returning success. A production Zero adapter is not included.

Multiple sources use `sources: { app, external }`; their schemas appear under `forms/app` and `forms/external`. Multiple submission integrations use `submissions: { web, mutations }`; actions appear under `actions/web` and `actions/mutations`. A single source or submission keeps flat output paths. Reuse the registered source instance in each operation provider. Unknown schema associations, conflicting artifacts and duplicate operation names are generation errors.

Generation synchronizes files marked `// Generated by Fieldwork.` within the configured form/action output directories and preserves application-owned files. Check mode detects obsolete files without deleting them. Configurations should own separate output directories.
