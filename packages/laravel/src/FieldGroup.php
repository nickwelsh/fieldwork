<?php

declare(strict_types=1);

namespace Fieldwork\Laravel;

use BackedEnum;

final class FieldGroup
{
    /** @var array{component: string|int, fields: array<string, string>, props: array<string, mixed>, label?: string, helpText?: string} */
    private array $metadata;

    private function __construct(BackedEnum|string $component)
    {
        $this->metadata = [
            'component' => $component instanceof BackedEnum ? $component->value : $component,
            'fields' => [],
            'props' => [],
        ];
    }

    public static function make(BackedEnum|string $component): self
    {
        return new self($component);
    }

    /** @param array<string, string> $fields */
    public function fields(array $fields): self
    {
        $this->metadata['fields'] = $fields;

        return $this;
    }

    public function label(string $label): self
    {
        $this->metadata['label'] = $label;

        return $this;
    }

    public function helpText(string $text): self
    {
        $this->metadata['helpText'] = $text;

        return $this;
    }

    /** @param array<string, mixed> $props */
    public function props(array $props): self
    {
        $this->metadata['props'] = array_replace($this->metadata['props'], $props);

        return $this;
    }

    /** @return array{component: string|int, fields: array<string, string>, props: array<string, mixed>, label?: string, helpText?: string} */
    public function toArray(): array
    {
        return $this->metadata;
    }
}
