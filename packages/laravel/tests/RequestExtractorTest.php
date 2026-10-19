<?php

declare(strict_types=1);

namespace Formbraid\Laravel\Tests;

use Formbraid\Laravel\Field;
use Formbraid\Laravel\FieldGroup;
use Formbraid\Laravel\RequestExtractor;
use Illuminate\Translation\ArrayLoader;
use Illuminate\Translation\Translator;
use Illuminate\Validation\Factory;
use Illuminate\Validation\Rule;
use InvalidArgumentException;

enum Priority: int
{
    case Normal = 1;
    case Urgent = 2;
}
use PHPUnit\Framework\TestCase;

final class RequestExtractorTest extends TestCase
{
    private function extractor(): RequestExtractor
    {
        return new RequestExtractor(require __DIR__.'/../config/formbraid.php');
    }

    public function test_rules_infer_components_constraints_and_labels_without_fields_metadata(): void
    {
        $request = new class
        {
            public function rules(): array
            {
                return ['first_name' => 'required|string|min:2|max:255', 'email' => ['required', 'email'], 'age' => ['nullable', 'integer', 'min:18'], 'newsletter' => ['required', 'boolean']];
            }
        };
        $form = json_decode(json_encode($this->extractor()->extract($request)['form'], JSON_THROW_ON_ERROR), true, flags: JSON_THROW_ON_ERROR);
        self::assertSame('First Name', $form['fields']['first_name']['label']);
        self::assertSame('TextField', $form['fields']['email']['component']);
        self::assertSame('email', $form['fields']['email']['props']['type']);
        self::assertSame(['required' => true, 'minLength' => 2, 'maxLength' => 255], $form['fields']['first_name']['constraints']);
        self::assertSame(['required' => false, 'min' => 18], $form['fields']['age']['constraints']);
        self::assertSame(false, $form['defaultValues']['newsletter']);
        self::assertNull($form['defaultValues']['age']);
    }

    public function test_metadata_overrides_preserve_inference_and_group_mappings(): void
    {
        $request = new class
        {
            public function rules(): array
            {
                return ['billing.city' => ['required', 'string'], 'zip' => ['required', 'string', 'min:5']];
            }

            public function fields(): array
            {
                return ['billing.city' => Field::make()->label('Town')->helpText('Delivery town.')];
            }

            public function groups(): array
            {
                return ['address' => FieldGroup::make('AddressAutocomplete')->fields(['city' => 'billing.city', 'postalCode' => 'zip'])];
            }
        };
        $form = json_decode(json_encode($this->extractor()->extract($request)['form'], JSON_THROW_ON_ERROR), true, flags: JSON_THROW_ON_ERROR);
        self::assertSame('TextField', $form['fields']['billing.city']['component']);
        self::assertSame('Town', $form['fields']['billing.city']['label']);
        self::assertSame(['city' => 'billing.city', 'postalCode' => 'zip'], $form['groups']['address']['fields']);
        self::assertSame(['city' => ''], $form['defaultValues']['billing']);
    }

    public function test_conditional_required_and_server_rules_are_preserved(): void
    {
        $request = new class
        {
            public function rules(): array
            {
                return ['company' => ['nullable', 'string', 'required_if:newsletter,true', 'unique:companies,name']];
            }
        };
        $extracted = $this->extractor()->extract($request);
        $form = json_decode(json_encode($extracted['form'], JSON_THROW_ON_ERROR), true, flags: JSON_THROW_ON_ERROR);
        self::assertSame([['field' => 'newsletter', 'operator' => 'equals', 'values' => ['true']]], $form['fields']['company']['constraints']['requiredWhen']);
        self::assertSame(['unique'], $form['fields']['company']['serverRules']);
        self::assertCount(1, $extracted['diagnostics']);
    }

    public function test_conditional_literals_preserve_laravel_missing_null_and_boolean_comparisons(): void
    {
        $validator = new Factory(new Translator(new ArrayLoader, 'en'));
        foreach ([
            ['required_if:trigger,null', 'equals', 'null', [], true],
            ['required_if:trigger,null', 'equals', 'null', ['trigger' => null], false],
            ['required_if:trigger,NuLl', 'equals', 'NuLl', ['trigger' => null], false],
            ['required_unless:trigger,null', 'notEquals', 'null', [], true],
            ['required_unless:trigger,yes', 'notEquals', 'yes', [], false],
            ['required_if:trigger,1', 'equals', '1', ['trigger' => true], true],
            ['required_if:trigger,0', 'equals', '0', ['trigger' => false], true],
            ['required_if:trigger,true', 'equals', 'true', ['trigger' => true], false],
            ['required_if:trigger,false', 'equals', 'false', ['trigger' => false], false],
            ['required_if:trigger,01', 'equals', '01', ['trigger' => 1], false],
            ['required_if:trigger,1.0', 'equals', '1.0', ['trigger' => '1'], false],
            ['required_if:trigger,1e0', 'equals', '1e0', ['trigger' => 1], false],
            ['required_if:trigger, 1 ', 'equals', ' 1 ', ['trigger' => '1'], false],
            ['required_if:trigger,foo', 'equals', 'foo', ['trigger' => 0], true],
            ['required_if:trigger,0x0', 'equals', '0x0', ['trigger' => 0], true],
            ['required_if:trigger,9007199254740993', 'equals', '9007199254740993', ['trigger' => '9007199254740992'], true],
        ] as [$rule, $operator, $literal, $data, $passes]) {
            $request = new class($rule)
            {
                public function __construct(private string $rule) {}

                public function rules(): array
                {
                    return ['details' => ['nullable', 'string', $this->rule]];
                }
            };
            $form = json_decode(json_encode($this->extractor()->extract($request)['form'], JSON_THROW_ON_ERROR), true, flags: JSON_THROW_ON_ERROR);
            self::assertSame([['field' => 'trigger', 'operator' => $operator, 'values' => [$literal]]], $form['fields']['details']['constraints']['requiredWhen']);
            self::assertSame($passes, $validator->make($data, $request->rules())->passes(), $rule);
        }
    }

    public function test_wildcard_required_children_reject_serialized_sparse_null_positions(): void
    {
        $config = require __DIR__.'/../config/formbraid.php';
        $config['fields']['types']['array'] = 'ArrayField';
        $request = new class
        {
            public function rules(): array
            {
                return ['rows' => ['array'], 'rows.*.name' => ['required', 'string']];
            }
        };
        $form = json_decode(json_encode((new RequestExtractor($config))->extract($request)['form'], JSON_THROW_ON_ERROR), true, flags: JSON_THROW_ON_ERROR);
        self::assertSame(['required' => true], $form['fields']['rows.*.name']['constraints']);
        $validator = new Factory(new Translator(new ArrayLoader, 'en'));
        $validation = $validator->make(json_decode('{"rows":[null,{"name":"valid"},null]}', true, flags: JSON_THROW_ON_ERROR), $request->rules());
        self::assertFalse($validation->passes());
        self::assertSame(['rows.0.name', 'rows.2.name'], array_keys($validation->errors()->toArray()));
        self::assertTrue($validator->make(['rows' => []], $request->rules())->passes());
    }

    public function test_array_options_keep_collection_types_defaults_and_element_membership(): void
    {
        $config = require __DIR__.'/../config/formbraid.php';
        $config['fields']['types']['array'] = 'OptionsField';
        $request = new class
        {
            public function rules(): array
            {
                return ['colors' => ['array', 'in:red,blue', 'max:2']];
            }
        };
        $extracted = (new RequestExtractor($config))->extract($request);
        $form = json_decode(json_encode($extracted['form'], JSON_THROW_ON_ERROR), true, flags: JSON_THROW_ON_ERROR);
        self::assertSame('array', $form['fields']['colors']['type']);
        self::assertSame('OptionsField', $form['fields']['colors']['component']);
        self::assertSame([], $form['defaultValues']['colors']);
        self::assertSame(['required' => false, 'maxItems' => 2.0, 'options' => ['red', 'blue']], (array) $extracted['form']['fields']->colors['constraints']);
        self::assertSame([], $extracted['diagnostics']);
        $validator = new Factory(new Translator(new ArrayLoader, 'en'));
        foreach ([[['red'], true], [['red', 'blue'], true], [[], true], [['green'], false], ['red', false]] as [$colors, $passes]) {
            self::assertSame($passes, $validator->make(['colors' => $colors], $request->rules())->passes());
        }
    }

    public function test_associative_arrays_infer_records_preserve_cardinality_and_initialize_parents_first(): void
    {
        $config = require __DIR__.'/../config/formbraid.php';
        $config['fields']['types']['array'] = 'ContainerField';
        $request = new class
        {
            public function rules(): array
            {
                return [
                    'profile.name' => ['string'], 'profile' => ['array', 'min:1', 'max:2'],
                    'rows.*.name' => ['required', 'string'], 'rows.*' => ['array', 'min:1', 'max:2'], 'rows' => ['array'],
                    'codes.01.name' => ['string'], 'codes.1.age' => ['integer'], 'codes' => ['array'],
                    'optional.name' => ['string'], 'optional' => ['nullable', 'array'],
                ];
            }
        };
        $extracted = (new RequestExtractor($config))->extract($request);
        $form = json_decode(json_encode($extracted['form'], JSON_THROW_ON_ERROR), true, flags: JSON_THROW_ON_ERROR);
        self::assertSame(['object', 'object', 'array', 'object', 'object'], array_map(static fn (string $name): string => $form['fields'][$name]['type'], ['profile', 'rows.*', 'rows', 'codes', 'optional']));
        self::assertSame('ContainerField', $form['fields']['rows.*']['component']);
        self::assertSame(['required' => false, 'minItems' => 1, 'maxItems' => 2], $form['fields']['rows.*']['constraints']);
        self::assertSame(['profile' => ['name' => ''], 'rows' => [], 'codes' => ['01' => ['name' => ''], 1 => ['age' => 0]], 'optional' => null], $form['defaultValues']);
        self::assertSame([], $extracted['diagnostics']);
        $validator = new Factory(new Translator(new ArrayLoader, 'en'));
        self::assertTrue($validator->make(['profile' => ['name' => 'Nick'], 'rows' => [['name' => 'Nick']]], $request->rules())->passes());
        self::assertFalse($validator->make(['profile' => ['name' => 'Nick'], 'rows' => [['name' => 'Nick', 'extra' => 1, 'other' => 2]]], $request->rules())->passes());
    }

    public function test_explicit_container_types_and_object_component_mappings_override_inference(): void
    {
        $config = require __DIR__.'/../config/formbraid.php';
        $config['fields']['types']['array'] = 'ArrayField';
        $config['fields']['types']['object'] = 'ObjectField';
        $request = new class
        {
            public function rules(): array
            {
                return ['record' => ['array'], 'record.name' => ['string'], 'codes' => ['array'], 'codes.0.name' => ['string'], 'forced' => ['array'], 'forced.name' => ['string']];
            }

            public function fields(): array
            {
                return ['codes' => Field::make('CustomRecord')->type('object'), 'forced' => Field::make()->type('array')];
            }
        };
        $form = json_decode(json_encode((new RequestExtractor($config))->extract($request)['form'], JSON_THROW_ON_ERROR), true, flags: JSON_THROW_ON_ERROR);
        self::assertSame('ObjectField', $form['fields']['record']['component']);
        self::assertSame('CustomRecord', $form['fields']['codes']['component']);
        self::assertSame('object', $form['fields']['codes']['type']);
        self::assertSame('array', $form['fields']['forced']['type']);
    }

    public function test_conflicting_types_fail_instead_of_silently_selecting_a_component(): void
    {
        $request = new class
        {
            public function rules(): array
            {
                return ['age' => ['string', 'integer']];
            }
        };
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('Conflicting value types');
        $this->extractor()->extract($request);
    }

    public function test_non_serializable_props_and_missing_component_mappings_fail(): void
    {
        $request = new class
        {
            public function rules(): array
            {
                return ['name' => ['string']];
            }

            public function fields(): array
            {
                return ['name' => Field::make()->props(['onChange' => static fn () => null])];
            }
        };
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('JSON values');
        $this->extractor()->extract($request);
    }

    public function test_enum_values_preserve_backing_types_and_numeric_rule_options(): void
    {
        $request = new class
        {
            public function rules(): array
            {
                return [
                    'priority' => ['required', Rule::enum(Priority::class)],
                    'rating' => ['in:1,2,3', 'integer'],
                    'score' => ['numeric', 'in:1.5,2.5'],
                ];
            }
        };
        $form = json_decode(json_encode($this->extractor()->extract($request)['form'], JSON_THROW_ON_ERROR), true, flags: JSON_THROW_ON_ERROR);
        self::assertSame([1, 2], $form['fields']['priority']['constraints']['options']);
        self::assertSame([1, 2, 3], $form['fields']['rating']['constraints']['options']);
        self::assertSame([1.5, 2.5], $form['fields']['score']['constraints']['options']);
        self::assertSame('SelectField', $form['fields']['priority']['component']);
    }

    public function test_file_size_and_date_bounds_remain_server_validation(): void
    {
        $request = new class
        {
            public function rules(): array
            {
                return ['photo' => ['file', 'max:1024'], 'birthday' => ['date', 'before:today']];
            }
        };
        $form = json_decode(json_encode($this->extractor()->extract($request)['form'], JSON_THROW_ON_ERROR), true, flags: JSON_THROW_ON_ERROR);
        self::assertSame(['file', 'max'], $form['fields']['photo']['serverRules']);
        self::assertArrayNotHasKey('max', $form['fields']['photo']['constraints']);
        self::assertNull($form['defaultValues']['photo']);
        self::assertSame(['date', 'before'], $form['fields']['birthday']['serverRules']);
    }
}
