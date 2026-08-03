'use client'

import React from 'react'
import { Button, FieldLabel, SelectInput, TextInput } from '@payloadcms/ui'

export const fieldWrapperStyle: React.CSSProperties = {
    marginBottom: '1.5rem',
}

export const descriptionStyle: React.CSSProperties = {
    fontSize: '0.8125rem',
    color: 'var(--theme-elevation-500, #6b7280)',
    marginTop: '0.25rem',
    lineHeight: 1.4,
}

export const messageBoxStyle = (variant: 'info' | 'warning' | 'error' | 'success'): React.CSSProperties => ({
    padding: '0.75rem 1rem',
    borderRadius: 'var(--style-radius, 0.25rem)',
    border: '1px solid',
    borderColor:
        variant === 'error'
            ? 'var(--theme-error-250, #fecaca)'
            : variant === 'warning'
                ? 'var(--theme-warning-250, #fde68a)'
                : variant === 'success'
                    ? 'var(--theme-success-250, #bbf7d0)'
                    : 'var(--theme-elevation-150, #e5e7eb)',
    backgroundColor:
        variant === 'error'
            ? 'var(--theme-error-100, #fef2f2)'
            : variant === 'warning'
                ? 'var(--theme-warning-100, #fffbeb)'
                : variant === 'success'
                    ? 'var(--theme-success-100, #f0fdf4)'
                    : 'var(--theme-elevation-50, #f9fafb)',
    color:
        variant === 'error'
            ? 'var(--theme-error-700, #b91c1c)'
            : variant === 'warning'
                ? 'var(--theme-warning-700, #b45309)'
                : variant === 'success'
                    ? 'var(--theme-success-700, #15803d)'
                    : 'var(--theme-elevation-500, #6b7280)',
    fontSize: '0.875rem',
    lineHeight: 1.4,
    marginBottom: '0.75rem',
})

export interface SelectOption {
    label: string
    value: string
}

/** The subset of Payload's client field config these components read. */
export interface ClientFieldConfig {
    label?: string | Record<string, string>
    admin?: { description?: string | Record<string, string> }
}

/** Payload localises label/description as {locale: string}; take the string form. */
function plainText(value: string | Record<string, string> | undefined): string | undefined {
    if (typeof value === 'string') return value
    if (value && typeof value === 'object') return Object.values(value)[0]
    return undefined
}

/**
 * A field component's label and description, taken from the field's OWN config with
 * a generic fallback.
 *
 * These used to be hardcoded inside each component, so every use of a component
 * rendered identically no matter what the field was actually for. That is actively
 * misleading once a component is reused: `lookup_collection` inside a Field Mapping
 * row was displayed as "Target Collection — Payload collection that incoming ERPNext
 * data will sync into", making an Item rule look like it synced into the category
 * collection it was merely looking values up in.
 */
export function fieldChrome(
    field: ClientFieldConfig | undefined,
    fallbackLabel: string,
    fallbackDescription: string,
): { label: string; description: string } {
    return {
        label: plainText(field?.label) || fallbackLabel,
        description: plainText(field?.admin?.description) || fallbackDescription,
    }
}

interface FieldWrapperProps {
    path: string
    label?: string
    description?: string
    children: React.ReactNode
}

export const FieldWrapper: React.FC<FieldWrapperProps> = ({ path, label, description, children }) => (
    <div style={fieldWrapperStyle}>
        {label && <FieldLabel label={label} path={path} />}
        {children}
        {description && <div style={descriptionStyle}>{description}</div>}
    </div>
)

export const LoadingState: React.FC<{ message: string }> = ({ message }) => (
    <div style={messageBoxStyle('info')}>⏳ {message}</div>
)

export const EmptyState: React.FC<{ message: string }> = ({ message }) => (
    <div style={messageBoxStyle('info')}>{message}</div>
)

export const ErrorState: React.FC<{ message: string }> = ({ message }) => (
    <div style={messageBoxStyle('error')}>{message}</div>
)

export const SuccessState: React.FC<{ message: string }> = ({ message }) => (
    <div style={messageBoxStyle('success')}>✅ {message}</div>
)

export const ConnectButton: React.FC<{ onClick: () => void; disabled?: boolean; children: React.ReactNode }> = ({ onClick, disabled, children }) => (
    <Button type="button" buttonStyle="primary" size="medium" disabled={disabled} onClick={onClick}>
        {children}
    </Button>
)

interface StyledSelectProps {
    path: string
    value: string
    options: SelectOption[]
    placeholder?: string
    onChange: (value: string) => void
}

export const StyledSelect: React.FC<StyledSelectProps> = ({
    path,
    value,
    options,
    placeholder = 'Select an option',
    onChange,
}) => (
    <SelectInput
        path={path}
        name={path}
        value={value}
        onChange={(option: unknown) => {
            const selected = Array.isArray(option) ? option[0] : option
            onChange(selected?.value != null ? String(selected.value) : '')
        }}
        options={[{ label: `— ${placeholder} —`, value: '' }, ...options]}
    />
)

interface StyledTextInputProps {
    path: string
    value: string
    onChange: (value: string) => void
    placeholder?: string
}

export const StyledTextInput: React.FC<StyledTextInputProps> = ({
    path,
    value,
    onChange,
    placeholder,
}) => (
    <TextInput
        path={path}
        value={value}
        onChange={(e: { target: { value: string } }) => onChange(e.target.value)}
        placeholder={placeholder}
    />
)
